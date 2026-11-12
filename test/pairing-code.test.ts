import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import test from 'node:test'

import { canonicalExecutorPayload, EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  ExecutorScopeSchema, type ExecutorPairingClaim } from '@nessie/executor-protocol'

import { createPairingCodeClient } from '../src/pairing-code.js'
import type { PendingPairingCode } from '../src/pairing-code-store.js'
import type { ExecutorLocalState } from '../src/state-store.js'
import type { TeamLabel } from '../src/team-label.js'

const executorId = '00000000-0000-4000-8000-000000000001'
const pairingId = '00000000-0000-4000-8000-000000000002'
const fingerprint = `sha256:${'a'.repeat(64)}`
const claim: ExecutorPairingClaim = {
  executorId, machineName: 'My computer', organization: { id: 'org', name: 'Acme' },
  team: { id: 'team', name: 'Platform' },
  scope: ExecutorScopeSchema.parse({ kind: 'private', organizationId: '00000000-0000-4000-8000-000000000003' }),
  claimDigest: `sha256:${'b'.repeat(64)}`,
}

const fixture = () => {
  let pending: PendingPairingCode | null = null
  let state: ExecutorLocalState | null = null
  let label: TeamLabel | null = null
  let stage = 'waiting'
  let loseStart = false
  let failRetirement = false
  let losePoll = false
  let refuseCancel = false
  let pairingLocked = false
  let mintGate: Promise<void> | null = null
  let workspaceHasArtifacts = false
  const events: string[] = []
  const requests: Record<string, unknown>[] = []
  const starts = new Map<string, { pairingId: string; code: string; fingerprint: string;
    expiresAt: string; pollIntervalSeconds: number }>()
  const client = createPairingCodeClient({
    assertWorkspaceMayChange: async () => {
      if (workspaceHasArtifacts) throw new Error('Resolve local drafts first')
    },
    acquirePairingLease: async () => {
      if (pairingLocked) throw new Error('pairing busy')
      pairingLocked = true
      return { release: async () => { pairingLocked = false } }
    },
    acquireExecutorDaemonLease: async () => ({ release: async () => undefined }),
    configureExecutorWorkspaceFolders: async (folders) => [...folders],
    loadPairingCode: async () => pending,
    savePairingCode: async (_directory, value) => { events.push('persist'); pending = structuredClone(value) },
    clearPairingCode: async () => { pending = null },
    loadExecutorState: async () => {
      if (!state) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return state
    },
    saveExecutorState: async (_directory, value) => { state = value },
    readTeamLabel: async () => label,
    saveTeamLabel: async (_directory, names, apiBaseUrl) => {
      label = { ...names, apiBaseUrl, checkedAt: '2026-11-08T12:00:00.000Z' }
      return label
    },
    clearExecutorState: async () => {
      if (failRetirement) { failRetirement = false; throw new Error('local write failed') }
      events.push('clear-old'); state = null
    },
    postPairing: async (_origin, action, value) => {
      const request = value as Record<string, unknown>
      events.push(action)
      requests.push(request)
      const key = pending?.machinePrivateKey ?? state?.machinePrivateKey
      assert.ok(key, 'key must be durable before any network call')
      const { signature, replacementSignature, ...payload } = request
      assert.ok(verify(null, Buffer.from(canonicalExecutorPayload(`nessie.executor.pairing.${action}.v1`, payload)),
        createPublicKey(createPrivateKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'pkcs8' })),
        Buffer.from(signature as string, 'base64url')))
      if (replacementSignature) {
        assert.ok(state)
        assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.pairing.replace.v1', payload)),
          createPublicKey(createPrivateKey({ key: Buffer.from(state.machinePrivateKey, 'base64url'), format: 'der', type: 'pkcs8' })),
          Buffer.from(replacementSignature as string, 'base64url')))
      }
      if (action === 'start') {
        if (mintGate) await mintGate
        const requestId = request.requestId as string
        if (!starts.has(requestId)) {
          stage = 'waiting'
          starts.set(requestId, { pairingId: `00000000-0000-4000-8000-${String(starts.size + 2).padStart(12, '0')}`,
            code: starts.size === 0 ? '01234567' : String(starts.size + 1).padStart(8, '0'),
            fingerprint, expiresAt: '2099-01-01T00:00:00.000Z', pollIntervalSeconds: 3 })
        }
        if (loseStart) { loseStart = false; throw new Error('response lost') }
        return starts.get(requestId)!
      }
      if (action === 'poll' && losePoll) { losePoll = false; throw new Error('poll response lost') }
      if (action === 'cancel' && refuseCancel) throw new Error('This pairing is no longer available.')
      return { status: stage, pairingId, fingerprint, expiresAt: '2099-01-01T00:00:00.000Z',
        ...(stage === 'waiting' ? {} : { claim }) }
    },
  })
  return {
    client, events, requests, pending: () => pending, state: () => state, label: () => label,
    forgetLabel: () => { label = null },
    // A claim in Nessie activates the pairing; the server's next poll answer is `confirmed`.
    claim: () => { stage = 'confirmed' }, loseResponse: () => { loseStart = true },
    wait: () => { stage = 'waiting' },
    expire: () => { stage = 'expired' },
    reject: () => { stage = 'rejected' },
    failRetirement: () => { failRetirement = true },
    losePoll: () => { losePoll = true },
    // Nessie deletes a code some time after it runs out and then refuses to cancel it.
    forgetCode: () => { refuseCancel = true },
    holdMint: () => {
      let release!: () => void
      mintGate = new Promise<void>((done) => { release = done })
      return release
    },
    retainDrafts: () => { workspaceHasArtifacts = true },
  }
}

const input = { apiBaseUrl: 'https://api.nessie.works', stateDir: '/state', workspaceFolders: [{ name: 'work', path: '/work' }] }

test('pairing preserves the key through response loss and saves the pairing on the first poll after the claim', async () => {
  const f = fixture()
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  const key = f.pending()?.machinePrivateKey
  const requestId = f.pending()?.request.requestId
  const waiting = await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(waiting.code, '01234567')
  assert.equal(f.pending()?.machinePrivateKey, key)
  assert.equal(f.pending()?.request.requestId, requestId)
  assert.equal(f.state(), null)
  f.claim()
  const view = await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(view.status, 'paired')
  assert.equal(view.organizationName, 'Acme')
  assert.equal(view.teamName, 'Platform')
  assert.ok(!f.events.includes('confirm'), 'the computer never asks for or sends a second consent')
  assert.equal(f.state()?.executorId, executorId)
  assert.deepEqual(f.state()?.descriptor.operationKeys, EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS)
  // A new team starts with the built-in programs only and every installed local app (contract §4.3, §4.5).
  assert.deepEqual(f.state()?.commandPolicy, {
    mode: 'allowlist', allowlist: [], denylist: [],
    trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true },
  })
  assert.deepEqual(f.state()?.mcpPolicy, { mode: 'installed', disabled: [] })
  assert.equal(Object.hasOwn(f.state()!.descriptor, 'commandPolicy'), false)
  assert.ok(f.requests.every((request) => !JSON.stringify(request).includes('"commandPolicy"')))
  assert.ok(f.requests.every((request) => !JSON.stringify(request).includes('"mcpPolicy"')))
  assert.ok(f.requests.every((request) => !JSON.stringify(request).includes('"trusted"')))
  assert.equal(f.pending(), null)
  assert.equal(Object.hasOwn(f.state()!, 'organizationName'), false)
  // The claim's names become the team's label at once, before any refresh.
  assert.deepEqual(f.label(), { organizationName: 'Acme', teamName: 'Platform', apiBaseUrl: input.apiBaseUrl,
    checkedAt: '2026-11-08T12:00:00.000Z' })
})

test('a connected team is named from its saved label, without asking Nessie or any person', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  const asked = f.events.length
  const named = await f.client.pairingCodeStatus(input.stateDir)
  assert.deepEqual([named.status, named.executorId, named.organizationName, named.teamName, named.apiBaseUrl],
    ['paired', executorId, 'Acme', 'Platform', input.apiBaseUrl])
  f.forgetLabel()
  const unnamed = await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(unnamed.status, 'paired')
  assert.equal(unnamed.organizationName, undefined)
  assert.equal(f.events.length, asked, 'reading a connected team\'s status sends nothing')
  assert.ok(!f.events.includes('connection'))
})

test('read-only pairing binds and retains the exact operations across response loss and browser claim', async () => {
  const f = fixture()
  const operationKeys = ['file.list', 'file.read']
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode({ ...input, operationKeys }), /response lost/)
  const pending = f.pending()!
  assert.deepEqual(pending.request.descriptor.descriptor.operationKeys, operationKeys)
  const publicKey = createPublicKey(createPrivateKey({
    key: Buffer.from(pending.machinePrivateKey, 'base64url'), format: 'der', type: 'pkcs8',
  }))
  assert.ok(verify(null, Buffer.from(canonicalExecutorPayload(
    'nessie.executor.descriptor.v1', pending.request.descriptor.descriptor,
  )), publicKey, Buffer.from(pending.request.descriptor.signature, 'base64url')))
  const request = structuredClone(pending.request)
  await f.client.startPairingCode({ ...input, operationKeys: [...operationKeys].reverse() })
  assert.deepEqual(f.pending()?.request.descriptor, request.descriptor)
  assert.equal(f.pending()?.request.requestId, request.requestId)
  assert.equal(f.pending()?.request.machinePublicKey, request.machinePublicKey)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  assert.deepEqual(f.state()?.descriptor.operationKeys, operationKeys)
  assert.deepEqual(f.state()?.descriptor.workspaceFolders, ['work'])
  assert.equal(f.pending(), null)
})

test('a selected operation policy cannot replace an unfinished or existing pairing implicitly', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  const requestCount = f.requests.length
  await assert.rejects(f.client.startPairingCode({ ...input, operationKeys: ['file.list', 'file.read'] }),
    /already uses different operations/)
  assert.equal(f.requests.length, requestCount)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  await assert.rejects(f.client.startPairingCode({ ...input, operationKeys: ['file.list', 'file.read'] }),
    /already paired with different operations/)
})

test('initial pairing rejects empty, duplicate, unknown and host-execution operations before network', async () => {
  for (const operationKeys of [[], ['file.read', 'file.read'], ['command.run'], ['mcp.call'], ['unknown']]) {
    const f = fixture()
    await assert.rejects(f.client.startPairingCode({ ...input, operationKeys }), /distinct workspace operations/)
    assert.equal(f.requests.length, 0)
    assert.equal(f.pending(), null)
  }
})

test('replacement signs with both keys and retains the old key until retirement is acknowledged', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  const oldKey = f.state()?.machinePrivateKey
  f.wait()
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode({ ...input, replace: true }), /response lost/)
  assert.equal(f.state()?.machinePrivateKey, oldKey)
  assert.notEqual(f.pending()?.machinePrivateKey, oldKey)
  assert.equal(f.pending()?.request.replacesExecutorId, executorId)
  await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(f.state(), null)
  assert.ok(f.events.lastIndexOf('persist') < f.events.lastIndexOf('clear-old'))
  await f.client.cancelPairingCode(input.stateDir)
  assert.ok(f.events.includes('cancel'))
  assert.equal(f.pending(), null)
})

test('pairing cancellation recovers a lost mint response and expired attempts can be restarted', async () => {
  const f = fixture()
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  await f.client.cancelPairingCode(input.stateDir)
  assert.equal(f.pending(), null)
  assert.equal(f.events.filter((event) => event === 'start').length, 2)
  assert.ok(f.events.includes('cancel'))
  await f.client.startPairingCode(input)
  f.expire()
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'expired')
  await f.client.cancelPairingCode(input.stateDir)
  f.wait()
  assert.equal((await f.client.startPairingCode(input)).status, 'waiting')
})

test('an attempt Nessie calls expired ends on the computer and is never reopened', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.expire()
  const expired = await f.client.pairingCodeStatus(input.stateDir)
  assert.deepEqual([expired.status, expired.code], ['expired', '01234567'])
  assert.equal(f.pending(), null)
  const polls = f.events.filter((event) => event === 'poll').length
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'idle')
  assert.equal(f.events.filter((event) => event === 'poll').length, polls, 'an ended attempt asks Nessie nothing')
  assert.equal(f.events.includes('cancel'), false)
})

test('cancel ends the attempt on the computer even when Nessie refuses or cannot be reached', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.forgetCode()
  assert.equal((await f.client.cancelPairingCode(input.stateDir)).status, 'cancelled')
  assert.ok(f.events.includes('cancel'), 'Nessie is still asked first')
  assert.equal(f.pending(), null)
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'idle')
  const offline = fixture()
  offline.loseResponse()
  await assert.rejects(offline.client.startPairingCode(input), /response lost/)
  offline.loseResponse()
  assert.equal((await offline.client.cancelPairingCode(input.stateDir)).status, 'cancelled')
  assert.equal(offline.pending(), null)
  assert.equal(offline.events.includes('cancel'), false)
})

test('starting pairing again replaces a server-confirmed expired attempt without cancelling it', async () => {
  const f = fixture()
  const first = await f.client.startPairingCode(input)
  const old = structuredClone(f.pending())!
  f.expire()
  const fresh = await f.client.startPairingCode(input)
  assert.equal(fresh.status, 'waiting')
  assert.notEqual(fresh.code, first.code)
  assert.notEqual(f.pending()?.response?.pairingId, old.response?.pairingId)
  assert.notEqual(f.pending()?.request.requestId, old.request.requestId)
  assert.notEqual(f.pending()?.machinePrivateKey, old.machinePrivateKey)
  assert.equal(f.events.filter(event => event === 'start').length, 2)
  assert.equal(f.events.includes('cancel'), false)
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'waiting')
})

test('retry preserves a pending attempt when expiry cannot be confirmed and recovers a lost fresh start', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  const old = structuredClone(f.pending())!
  f.expire()
  f.losePoll()
  await assert.rejects(f.client.startPairingCode(input), /poll response lost/)
  assert.deepEqual(f.pending(), old)
  assert.equal(f.events.filter(event => event === 'start').length, 1)
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  const fresh = structuredClone(f.pending())!
  assert.notEqual(fresh.machinePrivateKey, old.machinePrivateKey)
  assert.notEqual(fresh.request.requestId, old.request.requestId)
  assert.equal(fresh.response, undefined)
  assert.equal((await f.client.startPairingCode(input)).status, 'waiting')
  assert.equal(f.pending()?.machinePrivateKey, fresh.machinePrivateKey)
  assert.equal(f.pending()?.request.requestId, fresh.request.requestId)
})

test('retry resumes waiting or claimed pairing before considering another destination or key', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  const old = structuredClone(f.pending())!
  const changed = { ...input, apiBaseUrl: 'https://api.deeptest.live', workspaceFolders: [], replace: true }
  assert.equal((await f.client.startPairingCode(changed)).status, 'waiting')
  assert.deepEqual(f.pending(), old)
  f.claim()
  const paired = await f.client.startPairingCode(changed)
  assert.equal(paired.status, 'paired')
  assert.equal(paired.apiBaseUrl, input.apiBaseUrl)
  assert.equal(f.state()?.machinePrivateKey, old.machinePrivateKey)
  assert.equal(f.events.filter(event => event === 'start').length, 1)
  assert.equal(f.events.includes('cancel'), false)
})

test('retry of an expired replacement preserves the acknowledged retirement and starts without another replacement', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  await f.client.startPairingCode({ ...input, replace: true })
  assert.equal(f.pending()?.request.replacesExecutorId, executorId)
  assert.equal(f.state(), null)
  f.expire()
  assert.equal((await f.client.startPairingCode({ ...input, replace: true })).status, 'waiting')
  assert.equal(f.pending()?.request.replacesExecutorId, undefined)
  assert.equal(f.events.filter(event => event === 'clear-old').length, 1)
  assert.equal(f.events.includes('cancel'), false)
})

test('replacement recovers a persisted mint before old state cleanup and a lost poll answer', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  f.wait()
  f.failRetirement()
  await assert.rejects(f.client.startPairingCode({ ...input, replace: true }), /local write failed/)
  assert.ok(f.pending()?.response)
  assert.ok(f.state())
  await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(f.state(), null)
  f.claim()
  f.losePoll()
  await assert.rejects(f.client.pairingCodeStatus(input.stateDir), /poll response lost/)
  assert.equal(f.state(), null)
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'paired')
  assert.equal(f.state()?.executorId, executorId)
  assert.equal(f.pending(), null)
})

test('pairing detects the existing organisation and refuses silently changing its Nessie service', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  const existing = await f.client.startPairingCode(input)
  assert.equal(existing.status, 'alreadyPaired')
  assert.equal(existing.organizationName, 'Acme')
  assert.equal(f.pending(), null)
  await assert.rejects(f.client.startPairingCode({
    ...input, apiBaseUrl: 'https://api.deeptest.live', replace: true,
  }), /same Nessie service/)
  assert.equal(f.pending(), null)
  assert.ok(f.state())
})

test('pairing serializes concurrent commands before reading or replacing pending keys', async () => {
  const f = fixture()
  const release = f.holdMint()
  const first = f.client.startPairingCode(input)
  await new Promise((done) => setImmediate(done))
  await assert.rejects(f.client.startPairingCode(input), /pairing busy/)
  release()
  await first
  await f.client.startPairingCode(input)
  assert.equal(f.events.filter((event) => event === 'start').length, 1)
})

test('replacement refuses retained workspace artifacts before revoking or generating another key', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.pairingCodeStatus(input.stateDir)
  const oldKey = f.state()?.machinePrivateKey
  f.retainDrafts()
  const priorEvents = [...f.events]
  await assert.rejects(f.client.startPairingCode({ ...input, replace: true }), /local drafts/)
  assert.deepEqual(f.events, priorEvents)
  assert.equal(f.state()?.machinePrivateKey, oldKey)
  assert.equal(f.pending(), null)
})

test('pairing clears a server-rejected attempt and retires a lost mint response after expiry', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.reject()
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'cancelled')
  assert.equal(f.pending(), null)
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  f.expire()
  await f.client.cancelPairingCode(input.stateDir)
  assert.equal(f.pending(), null)
  f.wait()
  assert.equal((await f.client.startPairingCode(input)).status, 'waiting')
})
