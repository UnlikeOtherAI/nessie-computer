import assert from 'node:assert/strict'
import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalExecutorPayload, type ExecutorPairingClaim } from '@nessie/executor-protocol'
import { createPairingCodeClient } from '../src/pairing-code.js'
import { findDuplicatePairing, findReusedPairing } from '../src/pairing-connections.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'
import { loadPairingCode } from '../src/pairing-code-store.js'
import { ExecutorApiError, type ExecutorApiClient } from '../src/api-client.js'

type Attempt = { key: string; claim: ExecutorPairingClaim; revoked: boolean; origin: string; retained?: string }

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-unique-team-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const organizationId = randomUUID()
  const attempts = new Map<string, Attempt>()
  let teamId = 'team-one'
  let loseReuse = false
  let cancelUnavailable = false
  let connectionUnavailable = false
  let unavailableConnection: string | undefined
  let wrongConnection = false
  const cancelled: string[] = []
  const pairing: ExecutorApiClient['pairing'] = async (origin, action, input) => {
    const request = input as Record<string, unknown>
    if (action === 'start') {
      attempts.set(request.requestId as string, { key: request.machinePublicKey as string, revoked: false, origin,
        claim: { executorId: randomUUID(), machineName: 'Fixture computer',
          organization: { id: organizationId, name: 'Same organisation name' },
          team: { id: teamId, name: 'Same team name' },
          scope: { kind: 'private', organizationId }, claimDigest: `sha256:${'a'.repeat(64)}` } })
    }
    const attempt = action === 'connection'
      ? [...attempts.values()].find(value => value.claim.executorId === request.executorId)
      : attempts.get((request.requestId ?? request.pairingId) as string)
    assert.ok(attempt)
    assert.equal(origin, attempt.origin)
    const { signature, retainedSignature, ...payload } = request
    const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(attempt.key, 'base64url'),
    ]) })
    assert.ok(verify(null, Buffer.from(canonicalExecutorPayload(`nessie.executor.pairing.${action}.v1`, payload)),
      key, Buffer.from(signature as string, 'base64url')))
    if (action === 'connection') {
      if (connectionUnavailable || unavailableConnection === attempt.claim.executorId) {
        throw new ExecutorApiError('Temporary outage', { status: 503 })
      }
      if (attempt.revoked) throw new ExecutorApiError('Inactive', { status: 410, code: 'EXECUTOR_PAIRING_CONNECTION_INACTIVE' })
      return { ...attempt.claim, ...(wrongConnection ? { executorId: randomUUID() } : {}) }
    }
    if (action === 'start') return { pairingId: request.requestId, code: '12345678',
      fingerprint: `sha256:${'b'.repeat(64)}`, expiresAt: '2099-01-01T00:00:00.000Z', pollIntervalSeconds: 3 }
    if (action === 'reuse') {
      const retained = [...attempts.values()].find(value => value.claim.executorId === request.retainedExecutorId)
      assert.ok(retained && !retained.revoked)
      const retainedKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(retained.key, 'base64url'),
      ]) })
      assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.pairing.reuse.v1', payload)),
        retainedKey, Buffer.from(retainedSignature as string, 'base64url')))
      attempt.revoked = true
      attempt.retained = retained.claim.executorId
      cancelled.push(attempt.claim.executorId)
      if (loseReuse) { loseReuse = false; throw new Error('Reuse response lost') }
    }
    if (action === 'cancel') {
      if (cancelUnavailable) throw new Error('Cancel delivery unavailable')
      attempt.revoked = true
      cancelled.push(attempt.claim.executorId)
    }
    const retained = [...attempts.values()].find(value => value.claim.executorId === attempt.retained)
    if (retained && action !== 'cancel') return { pairingId: request.pairingId,
      fingerprint: `sha256:${'b'.repeat(64)}`, expiresAt: '2099-01-01T00:00:00.000Z',
      status: 'reused', reusedConnection: retained.claim }
    return { pairingId: request.pairingId, fingerprint: `sha256:${'b'.repeat(64)}`,
      expiresAt: '2099-01-01T00:00:00.000Z', status: attempt.revoked ? 'rejected' : 'confirmed',
      ...(attempt.revoked ? {} : { claim: attempt.claim }) }
  }
  const createClient = () => createPairingCodeClient({ postPairing: pairing,
    findDuplicatePairing: (directory, origin, claim, connectionRoot) =>
      findDuplicatePairing(directory, origin, claim, connectionRoot, { pairing }),
    findReusedPairing: (directory, origin, executorId, connectionRoot) =>
      findReusedPairing(directory, origin, executorId, connectionRoot, { pairing }),
  })
  let client = createClient()
  const directory = (name: string) => join(root, name)
  return {
    root, directory, cancelled,
    revoke: (id: string) => {
      for (const attempt of attempts.values()) if (attempt.claim.executorId === id) attempt.revoked = true
    },
    start: (name: string, apiBaseUrl = 'https://nessie.example') => client.startPairingCode({
      stateDir: directory(name), connectionRoot: root, apiBaseUrl, workspaceFolders: [{ name: 'work', path: workspace }],
    }),
    finish: (name: string) => client.pairingCodeStatus(directory(name), root),
    team: (id: string) => { teamId = id },
    loseReuse: () => { loseReuse = true },
    cancelUnavailable: (value: boolean) => { cancelUnavailable = value },
    cancel: (name: string) => client.cancelPairingCode(directory(name)),
    restart: () => { client = createClient() },
    outage: (value: boolean) => { connectionUnavailable = value },
    unavailable: (id: string) => { unavailableConnection = id },
    wrongConnection: () => { wrongConnection = true },
    close: () => rm(root, { recursive: true, force: true }),
  }
}

test('adding the same team selects its existing connection without replacing keys or grants', async () => {
  const f = await fixture()
  try {
    await f.start('first')
    const first = await f.finish('first')
    const saved = await loadExecutorState(f.directory('first'))
    const expected = structuredClone(saved)
    saved.commandPolicy = { mode: 'allowlist', allowlist: ['existing-tool'], denylist: ['blocked-tool'] }
    await saveExecutorState(f.directory('first'), saved, expected)
    await f.start('second')
    const second = await f.finish('second')
    assert.equal(second.status, 'alreadyPaired')
    assert.equal(second.executorId, first.executorId)
    assert.deepEqual(await loadExecutorState(f.directory('first')), saved)
    await assert.rejects(loadExecutorState(f.directory('second')), { code: 'ENOENT' })
    assert.equal(await loadPairingCode(f.directory('second')), null)
    assert.equal(f.cancelled.length, 1)
    assert.notEqual(f.cancelled[0], first.executorId)
  } finally { await f.close() }
})

test('equal labels do not merge different teams or different Nessie servers', async () => {
  const f = await fixture()
  try {
    await f.start('first'); await f.finish('first')
    f.team('team-two')
    await f.start('second')
    assert.equal((await f.finish('second')).status, 'paired')
    await f.start('third', 'https://another.example')
    assert.equal((await f.finish('third')).status, 'paired')
    assert.deepEqual(f.cancelled, [])
  } finally { await f.close() }
})

test('overlapping activations publish only one connection for the team', async () => {
  const f = await fixture()
  try {
    await f.start('first'); await f.start('second')
    const result = await Promise.allSettled([f.finish('first'), f.finish('second')])
    assert.equal(result.filter(value => value.status === 'fulfilled' && value.value.status === 'paired').length, 1)
    const retried = await Promise.all(result.map((value, index) => value.status === 'fulfilled'
      ? value.value : f.finish(index === 0 ? 'first' : 'second')))
    assert.equal(retried.filter(value => value.status === 'paired').length, 1)
    assert.equal(retried.filter(value => value.status === 'alreadyPaired').length, 1)
    assert.equal(f.cancelled.length, 1)
  } finally { await f.close() }
})

test('a lost reuse response survives restart and resolves to the retained connection', async () => {
  const f = await fixture()
  try {
    await f.start('first'); const original = await f.finish('first')
    await f.start('second'); f.loseReuse()
    await assert.rejects(f.finish('second'), /Reuse response lost/)
    assert.ok(await loadPairingCode(f.directory('second')))
    f.restart()
    const recovered = await f.finish('second')
    assert.equal(recovered.status, 'alreadyPaired')
    assert.equal(recovered.executorId, original.executorId)
    await assert.rejects(loadExecutorState(f.directory('second')), { code: 'ENOENT' })
    assert.equal((await loadExecutorState(f.directory('first'))).executorId, original.executorId)
  } finally { await f.close() }
})

test('an unavailable or substituted existing connection cannot permit a duplicate', async () => {
  const f = await fixture()
  try {
    await f.start('first'); await f.finish('first')
    await f.start('second'); f.outage(true)
    await assert.rejects(f.finish('second'), /Temporary outage/)
    assert.ok(await loadPairingCode(f.directory('second')))
    await assert.rejects(loadExecutorState(f.directory('second')), { code: 'ENOENT' })
    f.outage(false); f.wrongConnection()
    await assert.rejects(f.finish('second'), /different computer/)
    assert.deepEqual(f.cancelled, [])
  } finally { await f.close() }
})

test('a server-revoked local connection does not block a new team and its local key remains unchanged', async () => {
  const f = await fixture()
  try {
    await f.start('first')
    const first = await f.finish('first')
    const retained = await loadExecutorState(f.directory('first'))
    f.revoke(first.executorId!)
    f.team('team-two')
    await f.start('second')
    assert.equal((await f.finish('second')).status, 'paired')
    assert.deepEqual(await loadExecutorState(f.directory('first')), retained)
    assert.deepEqual(f.cancelled, [])
  } finally { await f.close() }
})

test('durable cancellation retries after restart without activating a confirmed server claim', async () => {
  const f = await fixture()
  try {
    await f.start('cancelled')
    const original = await loadPairingCode(f.directory('cancelled'))
    f.cancelUnavailable(true)
    assert.deepEqual(await f.cancel('cancelled'), { status: 'cancelled', cancellationPending: true })
    const retained = await loadPairingCode(f.directory('cancelled'))
    assert.equal(retained?.cancelRequested, true)
    assert.equal(retained?.machinePrivateKey, original?.machinePrivateKey)
    f.restart()
    assert.deepEqual(await f.finish('cancelled'), { status: 'cancelled', cancellationPending: true })
    await assert.rejects(loadExecutorState(f.directory('cancelled')), { code: 'ENOENT' })
    f.cancelUnavailable(false)
    assert.deepEqual(await f.finish('cancelled'), { status: 'cancelled' })
    assert.equal(await loadPairingCode(f.directory('cancelled')), null)
    assert.equal(f.cancelled.length, 1)
    await assert.rejects(loadExecutorState(f.directory('cancelled')), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('lost reuse recovery checks only the retained connection when another team becomes unavailable', async () => {
  const f = await fixture()
  try {
    f.team('another-team')
    await f.start('a-other')
    const other = await f.finish('a-other')
    f.team('target-team')
    await f.start('z-retained')
    const retained = await f.finish('z-retained')
    await f.start('pending'); f.loseReuse()
    await assert.rejects(f.finish('pending'), /Reuse response lost/)
    f.unavailable(other.executorId!)
    f.restart()
    const recovered = await f.finish('pending')
    assert.equal(recovered.status, 'alreadyPaired')
    assert.equal(recovered.executorId, retained.executorId)
  } finally { await f.close() }
})
