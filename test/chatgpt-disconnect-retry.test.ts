import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { finalizeChatgptDisconnect } from '../src/chatgpt-profile-disconnect.js'
import { ChatgptProfileStore } from '../src/chatgpt-profile-store.js'
import { ChatgptProfileRecordSchema } from '../src/chatgpt-profile-records.js'
import type { PersonalStateMutation } from '../src/personal-state-mutation.js'

for (const blocking of ['none', 'credentials.json', 'companion-key.json', 'native-proof'] as const) {
  test(`expired initial login cleanup permits a fresh key only after clearance: ${blocking}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessie-chatgpt-retry-'))
    await chmod(root, 0o700)
    const store = new ChatgptProfileStore({ directory: root })
    const profileId = randomUUID()
    const profile = await store.update(profileId, () => ChatgptProfileRecordSchema.parse({
      format: 1, revision: 0, profileId, label: 'ChatGPT OR Main',
      apiOrigin: 'https://api.nessie.works', executorId: randomUUID(),
      organizationId: randomUUID(), teamId: randomUUID(), phase: 'disconnecting', reason: 'connection_unavailable',
      planEnabled: false, hostExecutionRestricted: true, operationId: randomUUID(), principal: null,
      accountGeneration: 1, consentRevision: 1, publicKey: 'p'.repeat(64), credentialProcess: null,
      registration: { clientId: null, extAgentHostId: randomUUID(), issuer: 'https://auth.openai.com', subject: null },
    }))
    let protectedProfile = true
    let checked = false
    const mutation: PersonalStateMutation = { root, durability: 'process_crash',
      ensureDirectory: async () => undefined, mutate: async () => { throw new Error('unexpected write') },
      barrier: async () => { checked = true; if (blocking === 'native-proof') throw new Error('unverified') },
    }
    const dependencies = { store, mutation, disconnect: async () => { throw new Error('offline') },
      guard: { deactivate: async (_id: string, verify: () => Promise<void>) => {
        await verify()
        protectedProfile = false
      } },
    }
    try {
      if (blocking.endsWith('.json')) await writeFile(join(store.profileDirectory(profileId), blocking), 'fixture', { mode: 0o600 })
      const clearing = finalizeChatgptDisconnect('/fixture-state', profile, dependencies)
      if (blocking === 'none') {
        await clearing
        const cleared = await store.read(profileId)
        assert.equal(cleared?.phase, 'disconnected')
        assert.equal(cleared?.publicKey, null, 'the removed key cannot route retry into old custody')
        assert.equal(cleared?.operationId, null)
        assert.equal(cleared?.label, profile.label)
        assert.deepEqual(cleared?.registration, profile.registration)
        assert.equal(checked, true)
        assert.equal(protectedProfile, false)
      } else {
        await assert.rejects(clearing)
        const retained = await store.read(profileId)
        assert.equal(retained?.publicKey, profile.publicKey)
        assert.equal(retained?.phase, 'disconnecting')
        assert.equal(protectedProfile, true)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
