import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { canonicalExecutorPayload } from '@nessie/executor-protocol'

import { runPairingCodeCli } from '../src/pairing-code-cli.js'
import { createUnpair } from '../src/unpair.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const keys = generateKeyPairSync('ed25519')
const state = {
  apiBaseUrl: 'https://api.nessie.works',
  executorId: '7ef55da4-52d3-40fd-8e76-f1b816c274ee',
  machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
} as ExecutorLocalState

const harness = (signOff: (origin: string, body: unknown) => Promise<unknown>) => {
  const events: string[] = []
  const unpair = createUnpair({
    acquireExecutorDaemonLease: async () => {
      events.push('lease')
      return { release: async () => { events.push('release') } }
    },
    loadExecutorState: async () => state,
    acquireChatgptPairingRetirement: async () => ({ release: async () => undefined }),
    signOff: async (origin, body) => { events.push('sign-off'); return signOff(origin, body) },
    remove: async (directory) => { events.push(`remove ${directory}`) },
    report: (message) => { events.push(`report ${message}`) },
  })
  return { events, unpair }
}

test('removing a team signs off with the machine key before deleting its directory', async () => {
  let sent: { origin: string; body: Record<string, string> } | undefined
  const { events, unpair } = harness(async (origin, body) => {
    sent = { origin, body: body as Record<string, string> }
  })
  assert.deepEqual(await unpair('/state/team'), { status: 'removed', signedOff: true })
  assert.deepEqual(events, ['lease', 'sign-off', `remove ${resolve('/state/team')}`, 'release'])
  assert.equal(sent?.origin, state.apiBaseUrl)
  const { signature, ...payload } = sent!.body
  assert.equal(payload.executorId, state.executorId)
  assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.pairing.sign-off.v1', payload)),
    createPublicKey(keys.publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(signature!, 'base64url')))
})

test('an unreachable Nessie still removes the team, and says so', async () => {
  const { events, unpair } = harness(async () => { throw new Error('fetch failed') })
  assert.deepEqual(await unpair('/state/team'), { status: 'removed', signedOff: false })
  assert.ok(events.includes(`remove ${resolve('/state/team')}`))
  assert.match(events.find((event) => event.startsWith('report')) ?? '', /fetch failed.*offline/s)
})

test('a running connection, the home folder or a filesystem root is never removed', async () => {
  const running = createUnpair({
    acquireExecutorDaemonLease: async () => { throw new Error('EXECUTOR_DAEMON_ALREADY_RUNNING') },
    remove: async () => { throw new Error('must not remove') },
  })
  await assert.rejects(running('/state/team'), /running\. Stop it first/)
  const { events, unpair } = harness(async () => undefined)
  await assert.rejects(unpair(homedir()), /not an executor connection/)
  await assert.rejects(unpair(resolve('/')), /not an executor connection/)
  assert.deepEqual(events, [])
})

test('the CLI names the connection to remove', async () => {
  await assert.rejects(runPairingCodeCli(['unpair'], 'linux'), /Choose the connection to remove/)
})

test('personal cleanup refusal preserves the pairing and releases its daemon lease', async () => {
  const events: string[] = []
  const unpair = createUnpair({ loadExecutorState: async () => state,
    acquireExecutorDaemonLease: async () => ({ release: async () => { events.push('release') } }),
    acquireChatgptPairingRetirement: async () => { throw new Error('Disconnect ChatGPT first') },
    signOff: async () => { events.push('sign-off') }, remove: async () => { events.push('remove') },
  })
  await assert.rejects(unpair('/state/team'), /Disconnect ChatGPT first/)
  assert.deepEqual(events, ['release'])
})

test('personal start fence remains held through sign-off and actual pairing removal', async () => {
  const events: string[] = []
  const unpair = createUnpair({ loadExecutorState: async () => state,
    acquireExecutorDaemonLease: async () => ({ release: async () => { events.push('daemon-release') } }),
    acquireChatgptPairingRetirement: async () => {
      events.push('personal-lock'); return { release: async () => { events.push('personal-release') } }
    },
    signOff: async () => { events.push('sign-off') }, remove: async () => { events.push('remove') },
  })
  await unpair('/state/team')
  assert.deepEqual(events, ['personal-lock', 'sign-off', 'remove', 'personal-release', 'daemon-release'])
})
