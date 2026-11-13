import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { canonicalExecutorJson, type ExecutorCommandEnvelope, type ExecutorOperationKey } from '@nessie/executor-protocol'

import { serveExecutor } from '../src/daemon-server.js'
import { setOwnerPaused } from '../src/owner-pause.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * The running daemon against a fake Nessie: a saved policy takes effect on the
 * live connection, and the owner's pause stops new work, reaches Nessie, and
 * survives a restart — including against an older Nessie that refuses the
 * heartbeat field.
 */

const EXECUTOR_ID = '00000000-0000-4000-8000-000000000c01'
const RUN_ID = '00000000-0000-4000-8000-000000000c02'
const packagedWindowsRun = process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const send = (response: ServerResponse, data: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(status === 200 ? { data } : { error: data }))
}

type FakeNessie = {
  apiBaseUrl: string
  claims: number
  descriptors: Array<{ connectionEpoch: string; revision: number }>
  heartbeats: Array<{ ownerPaused?: unknown }>
  /** The revision Nessie signs commands against: the last one submitted. */
  revision: number
  /** Answer a heartbeat carrying `ownerPaused` the way an older, strict Nessie does. */
  older: boolean
  run: (operationKey: ExecutorOperationKey, args: Record<string, unknown>, revision?: number) =>
    Promise<Record<string, unknown>>
  close: () => Promise<void>
}

let commandSequence = 0

const startFakeNessie = async (): Promise<FakeNessie> => {
  let epoch = 0
  const queue: ExecutorCommandEnvelope[] = []
  const results = new Map<string, (result: Record<string, unknown>) => void>()
  const nessie = {
    apiBaseUrl: '', claims: 0, descriptors: [], heartbeats: [], revision: 0, older: false,
  } as unknown as FakeNessie
  const server = createServer(async (request, response) => {
    if (request.url === '/api/executor-daemon/socket') return send(response, { code: 'NOT_FOUND', message: 'none' }, 404)
    const body = await readBody(request)
    switch (request.url) {
      case '/api/executor-daemon/challenge':
        return send(response, { challenge: `${'d'.repeat(80)}.${String(epoch + 1).padStart(64, '0')}`,
          expiresAt: '2099-01-01T00:00:00.000Z' })
      case '/api/executor-daemon/claim':
        nessie.claims += 1
        epoch += 1
        return send(response, { connectionEpoch: String(epoch), status: 'online' })
      case '/api/executor-daemon/descriptor': {
        const revision = ((body.descriptor as { descriptor: { revision: number } }).descriptor).revision
        nessie.descriptors.push({ connectionEpoch: String(body.connectionEpoch), revision })
        nessie.revision = revision
        return send(response, { reviewStatus: 'active', revision })
      }
      case '/api/executor-daemon/heartbeat':
        nessie.heartbeats.push({ ownerPaused: body.ownerPaused })
        if (nessie.older && 'ownerPaused' in body) {
          return send(response, { code: 'VALIDATION_ERROR', message: "Unrecognized key(s) in object: 'ownerPaused'" }, 400)
        }
        return send(response, { connectionEpoch: String(epoch), status: 'online' })
      case '/api/executor-daemon/session-views':
        return send(response, { requests: [] })
      case '/api/executor-daemon/commands/poll':
        if (body.activeCommand) return send(response, { command: null, cancellation: null })
        return send(response, { command: queue[0] ?? null })
      case '/api/executor-daemon/commands/receipt': {
        const receipt = body.receipt as { commandId: string; state: string }
        // A restarted daemon replays the receipt its predecessor's journal still held.
        if (receipt.state === 'result_acknowledged') {
          const index = queue.findIndex((command) => command.commandId === receipt.commandId)
          if (index >= 0) queue.splice(index, 1)
          results.get(receipt.commandId)?.(body.result as Record<string, unknown>)
          results.delete(receipt.commandId)
        }
        return send(response, { recorded: true })
      }
      default:
        return send(response, { code: 'NOT_FOUND', message: `Unexpected route ${request.url}` }, 404)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  nessie.apiBaseUrl = `http://127.0.0.1:${address.port}`
  nessie.run = (operationKey, args, revision = nessie.revision) => new Promise((resolve) => {
    commandSequence += 1
    const payload = { args, runId: RUN_ID }
    const commandId = `00000000-0000-4000-8000-${String(0xd00 + commandSequence).padStart(12, '0')}`
    results.set(commandId, resolve)
    queue.push({
      argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
      bindingFence: String(commandSequence), bindingId: '00000000-0000-4000-8000-000000000c03' as never,
      capabilityRevision: revision, commandId: commandId as never, expiresAt: '2099-01-01T00:00:00.000Z',
      idempotencyKey: commandId, operationKey, payload,
    })
  })
  nessie.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return nessie
}

const eventually = async (what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const pairedState = async (stateDir: string, workspace: string, apiBaseUrl: string): Promise<ExecutorLocalState> => {
  const keys = generateKeyPairSync('ed25519')
  const state: ExecutorLocalState = {
    apiBaseUrl,
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [] },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read', 'sandbox.stop'], profiles: ['workspace_sandbox'], revision: 1,
      workspaceFolders: ['workspace'],
    },
    executorId: EXECUTOR_ID,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    workspaceFolders: [{ name: 'workspace', path: workspace }],
  }
  await saveExecutorState(stateDir, state)
  // Existing coding sessions stay off: this daemon fronts no conversations.
  await writeFile(join(stateDir, 'existing-coding-sessions.json'), JSON.stringify({ enabled: false }))
  return state
}

const serve = (stateDir: string, state: ExecutorLocalState) => {
  const liveness = new PassThrough()
  const running = serveExecutor(stateDir, state, { parentLiveness: liveness, runtime: {
    entry: packagedWindowsRun ? join(dirname(process.execPath), 'nessie-executor.cjs')
      : fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    execArgv: packagedWindowsRun ? [] : ['--import', 'tsx'],
    execPath: process.execPath, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  } })
  return { stop: async () => { liveness.end(); await running } }
}

const fixture = async () => {
  const stateDir = await ensureOwnerOnlyStateDirectory(await mkdtemp(join(tmpdir(), 'nessie-live-apply-state-')))
  const workspace = await mkdtemp(join(tmpdir(), 'nessie-live-apply-workspace-'))
  const nessie = await startFakeNessie()
  const state = await pairedState(stateDir, workspace, nessie.apiBaseUrl)
  return {
    stateDir, nessie, state,
    cleanup: async () => {
      await nessie.close()
      await rm(stateDir, { force: true, recursive: true })
      await rm(workspace, { force: true, recursive: true })
    },
  }
}

test('a policy saved while the team runs is enforced on the same connection, without a restart', {
  skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000,
}, async () => {
  const { stateDir, nessie, state, cleanup } = await fixture()
  const daemon = serve(stateDir, state)
  try {
    await eventually('the daemon has connected', () => nessie.descriptors.length > 0)
    const before = nessie.revision
    assert.deepEqual(await nessie.run('sandbox.stop', {}), { status: 'no_active_sandbox', success: true })

    // The owner takes sandbox.stop away while the team runs.
    const saved = await loadExecutorState(stateDir)
    await configureExecutorLocalPolicy(stateDir, saved,
      saved.descriptor.operationKeys.filter((operationKey) => operationKey !== 'sandbox.stop'))

    try {
      await eventually('Nessie has the new revision', () => nessie.revision === before + 1)
    } catch (error) {
      assert.fail(`${String(error)} Descriptor history: ${JSON.stringify(nessie.descriptors)}`)
    }
    assert.equal(nessie.claims, 1, 'the daemon kept its connection')
    assert.deepEqual(nessie.descriptors.at(-1), { connectionEpoch: '1', revision: before + 1 })
    assert.deepEqual(await nessie.run('sandbox.stop', {}), { code: 'EXECUTOR_LOCAL_POLICY_DENIED', success: false })
    assert.deepEqual(await nessie.run('sandbox.stop', {}, before), { code: 'EXECUTOR_DESCRIPTOR_STALE', success: false })
    assert.equal(nessie.claims, 1)
  } finally {
    await daemon.stop()
    await cleanup()
  }
})

test('a pause stops new work at once, reaches Nessie, and holds through a restart and an older Nessie', {
  skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000,
}, async () => {
  const { stateDir, nessie, state, cleanup } = await fixture()
  let daemon = serve(stateDir, state)
  try {
    await eventually('the daemon has connected', () => nessie.heartbeats.length > 0)
    await setOwnerPaused(stateDir, true)
    await eventually('Nessie heard the pause', () => nessie.heartbeats.some((beat) => beat.ownerPaused === true))
    const paused = await nessie.run('file.list', { path: 'workspace' })
    assert.equal(paused.code, 'EXECUTOR_OWNER_PAUSED')
    // A stop only ends work, so it still ends it.
    assert.deepEqual(await nessie.run('sandbox.stop', {}), { status: 'no_active_sandbox', success: true })

    // Restarted against an older Nessie, the team comes up paused and stays connected.
    await daemon.stop()
    nessie.older = true
    const heard = nessie.heartbeats.length
    daemon = serve(stateDir, await loadExecutorState(stateDir))
    await eventually('the older Nessie was answered without the field',
      () => nessie.heartbeats.slice(heard).some((beat) => beat.ownerPaused === undefined))
    assert.equal(nessie.heartbeats[heard]?.ownerPaused, true, 'the first heartbeat tried to say it')
    assert.equal((await nessie.run('file.list', { path: 'workspace' })).code, 'EXECUTOR_OWNER_PAUSED')
    const claims = nessie.claims

    await setOwnerPaused(stateDir, false)
    const resumed = nessie.heartbeats.length
    await eventually('Nessie heard the resume', () => nessie.heartbeats.length > resumed)
    assert.notEqual((await nessie.run('file.list', { path: 'workspace' })).code, 'EXECUTOR_OWNER_PAUSED')
    assert.equal(nessie.claims, claims, 'neither the refusal nor the resume cost the connection')
  } finally {
    await daemon.stop()
    await cleanup()
  }
})
