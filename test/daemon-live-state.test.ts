import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import { ExecutorApiError } from '../src/api-client.js'
import { localCommandPolicyOf, localCommandPolicyPermits } from '../src/command-policy.js'
import { createDaemonLiveApply } from '../src/daemon-live-apply.js'
import { createDaemonLiveState } from '../src/daemon-live-state.js'
import { withAnyProgram, withRule } from '../src/daemon-program-admission.js'
import { daemonToolsKey } from '../src/daemon-tools.js'
import type { ExecutorLocalState } from '../src/state-store.js'

// A real key: live apply signs what it submits.
const machinePrivateKey = generateKeyPairSync('ed25519').privateKey
  .export({ format: 'der', type: 'pkcs8' }).toString('base64url')

const state = (revision: number, allowlist: string[] = ['git *']): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  commandPolicy: { mode: 'allowlist', allowlist, denylist: ['git push *'] },
  connectionEpoch: '3',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['file.list', 'file.read'], profiles: ['workspace_sandbox'], revision,
  },
  executorId: '00000000-0000-4000-8000-000000000b01',
  machinePrivateKey,
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
})

test('the view answers every read from the current state, and nothing can write through it', () => {
  const live = createDaemonLiveState(state(1))
  const { view } = live
  assert.equal(view.descriptor.revision, 1)
  live.set(state(2, ['pnpm *']))
  assert.equal(view.descriptor.revision, 2)
  assert.deepEqual(localCommandPolicyOf(view).allowlist, ['pnpm *'])
  assert.deepEqual({ ...view }, live.current)
  assert.equal('browserSandbox' in view, false)
  assert.throws(() => { (view as { executorId: string }).executorId = 'other' }, TypeError)
  assert.throws(() => live.set({ ...state(3), executorId: '00000000-0000-4000-8000-000000000b02' }), /one team/u)
})

test('a launch allowed once runs under its own rules, which never reach the live state', () => {
  const live = createDaemonLiveState(state(1))
  const once = { ...live.view, commandPolicy: withRule(live.commandRules, 'ls *') }
  assert.equal(localCommandPolicyPermits(once, 'ls', ['-la']), true)
  // The denylist still wins over a lent rule.
  assert.equal(localCommandPolicyPermits(once, 'git', ['push', 'origin']), false)
  assert.equal(localCommandPolicyPermits(live.view, 'ls', ['-la']), false)
  assert.deepEqual(live.commandRules.allowlist, ['git *'])
})

test('a path launch runs under "any program not denied" for itself alone, and the denylist still wins', () => {
  const live = createDaemonLiveState(state(1))
  const once = { ...live.view, commandPolicy: withAnyProgram(live.commandRules) }
  assert.equal(localCommandPolicyPermits(once, 'htop', []), true)
  assert.equal(localCommandPolicyPermits(once, 'git', ['push', 'origin']), false)
  assert.equal(live.commandRules.mode, 'allowlist')
})

test('reload swaps in the saved policy, keeps the connection and submits the revision under it', async () => {
  const live = createDaemonLiveState(state(1))
  let saved: ExecutorLocalState = { ...state(2, ['git *', 'ls *']), connectionEpoch: '2' }
  const submitted: Array<{ connectionEpoch: string; revision: number }> = []
  const apply = createDaemonLiveApply('/private/state', live, {
    api: { submitDescriptor: async (_url, input) => {
      const revision = (input.descriptor as { descriptor: { revision: number } }).descriptor.revision
      submitted.push({ connectionEpoch: input.connectionEpoch, revision })
      return { reviewStatus: 'active', revision }
    } },
    loadState: async () => saved,
    saveState: async () => { throw new Error('a plain reload writes nothing') },
    log: () => undefined,
  })
  assert.equal(await apply.reload(), true)
  assert.equal(live.current.connectionEpoch, '3', 'the daemon keeps its own connection')
  assert.equal(localCommandPolicyPermits(live.view, 'ls', []), true)
  assert.deepEqual(submitted, [{ connectionEpoch: '3', revision: 2 }])
  // The same saved state again changes nothing and sends nothing.
  assert.equal(await apply.reload(), false)
  saved = { ...saved, descriptor: { ...saved.descriptor } }
  await apply.retry()
  assert.equal(submitted.length, 1)
})

test('a failed submission keeps the narrowed policy enforced and is retried until Nessie has it', async () => {
  const live = createDaemonLiveState(state(1, ['git *', 'ls *']))
  let reachable = false
  const submitted: number[] = []
  const apply = createDaemonLiveApply('/private/state', live, {
    api: { submitDescriptor: async (_url, input) => {
      if (!reachable) throw new ExecutorApiError('timed out', { code: 'EXECUTOR_API_TIMEOUT' })
      submitted.push((input.descriptor as { descriptor: { revision: number } }).descriptor.revision)
      return { reviewStatus: 'active', revision: 2 }
    } },
    loadState: async () => state(2, ['git *']),
    saveState: async () => undefined,
    log: () => undefined,
  })
  await apply.reload()
  assert.equal(localCommandPolicyPermits(live.view, 'ls', []), false, 'narrowing holds before Nessie hears it')
  reachable = true
  await apply.retry()
  await apply.retry()
  assert.deepEqual(submitted, [2])
})

test('a revision Nessie already holds with other content is saved as the next one and submitted', async () => {
  const live = createDaemonLiveState(state(1))
  let disk = state(2, ['git *', 'ls *'])
  const submitted: number[] = []
  const apply = createDaemonLiveApply('/private/state', live, {
    api: { submitDescriptor: async (_url, input) => {
      const revision = (input.descriptor as { descriptor: { revision: number } }).descriptor.revision
      if (revision === 2) throw new ExecutorApiError('conflict', { code: 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT' })
      submitted.push(revision)
      return { reviewStatus: 'active', revision }
    } },
    loadState: async () => disk,
    saveState: async (_dir, next, expected) => {
      assert.equal(expected, disk)
      disk = next
    },
    log: () => undefined,
  })
  await apply.reload()
  assert.deepEqual(submitted, [3])
  assert.equal(disk.descriptor.revision, 3)
  assert.equal(live.current.descriptor.revision, 3)
  assert.equal(live.current.connectionEpoch, '3')
})

test('local apps are rebuilt only when their launch specs, bridge facts or limits change', () => {
  const before = state(1)
  assert.equal(daemonToolsKey(before), daemonToolsKey(state(2, ['ls *'])), 'rules and revisions are not inputs')
  assert.notEqual(daemonToolsKey(before), daemonToolsKey({
    ...before, mcpServers: [{ name: 'kelpie', command: ['/usr/local/bin/kelpie', 'mcp'] }],
  }))
  assert.notEqual(daemonToolsKey(before), daemonToolsKey({
    ...before, descriptor: { ...before.descriptor, limits: { ...before.descriptor.limits, maxSessions: 2 } },
  }))
})
