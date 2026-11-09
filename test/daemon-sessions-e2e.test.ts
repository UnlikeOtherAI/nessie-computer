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
import { detectExecutorHost } from '../src/host-platform.js'
import { listProgramRequests, writeProgramRequestAnswer } from '../src/program-requests.js'
import { runSessionsCommand } from '../src/session-cli.js'
import { readSessions } from '../src/session-snapshot.js'
import { listSessionStops } from '../src/session-stops.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * The running daemon against a fake Nessie that speaks the concurrent poll
 * (`docs/sessions-and-concurrency.md`): commands of one session run side by
 * side, a program request holds only its own command and shows in the
 * owner's list, the owner's Stop reaches Nessie, and an older Nessie that
 * refuses the new fields still gets its work done one command at a time.
 */

const EXECUTOR_ID = '00000000-0000-4000-8000-000000000e01'
const RUN_ID = '00000000-0000-4000-8000-000000000e02'
const SESSION = '00000000-0000-4000-8000-000000000e03'
const OTHER_SESSION = '00000000-0000-4000-8000-000000000e04'
const packagedWindowsRun = process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'

/**
 * A program request needs `command.run`, which a computer offers only with a
 * sandbox backend (`assertHostSupportsOperations`): a Linux host without
 * read/write access to /dev/kvm, as CI runners are, refuses it when the team
 * is configured. Those two tests run where the backend exists.
 */
const sandboxBackend = (() => {
  try { return detectExecutorHost().sandboxBackend } catch { return 'none' }
})()
const NO_SANDBOX_SKIP: string | false = sandboxBackend === 'none'
  ? 'command.run needs a sandbox backend (KVM, Hyper-V or Virtualization.framework) on this computer.'
  : false

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const send = (response: ServerResponse, data: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(status === 200 ? { data } : { error: data }))
}

type Queued = {
  envelope: ExecutorCommandEnvelope
  accepted: boolean
  resolve: (result: Record<string, unknown>) => void
}

const startFakeNessie = async (options: { strict?: boolean } = {}) => {
  let sequence = 0
  const queue: Queued[] = []
  const polls: Record<string, unknown>[] = []
  const closes: Array<{ sessionId: string; reason: string }> = []
  const nessie = { apiBaseUrl: '', polls, revision: 0 }
  const server = createServer(async (request, response) => {
    if (request.url === '/api/executor-daemon/socket') return send(response, { code: 'NOT_FOUND', message: 'none' }, 404)
    const body = await readBody(request)
    switch (request.url) {
      case '/api/executor-daemon/challenge':
        return send(response, { challenge: `${'d'.repeat(80)}.${'1'.padStart(64, '0')}`, expiresAt: '2099-01-01T00:00:00.000Z' })
      case '/api/executor-daemon/claim':
        return send(response, { connectionEpoch: '1', status: 'online' })
      case '/api/executor-daemon/descriptor': {
        nessie.revision = ((body.descriptor as { descriptor: { revision: number } }).descriptor).revision
        return send(response, { reviewStatus: 'active', revision: nessie.revision })
      }
      case '/api/executor-daemon/heartbeat':
        return send(response, { connectionEpoch: '1', status: 'online' })
      case '/api/executor-daemon/session-views':
        return send(response, { requests: [] })
      case '/api/executor-daemon/commands/poll': {
        polls.push(body)
        if (body.concurrency !== undefined) {
          if (options.strict) {
            return send(response, { code: 'VALIDATION_ERROR', message: "Unrecognized key(s) in object: 'concurrency'" }, 400)
          }
          // The owner stopped a session: close it, as Nessie does.
          for (const sessionId of (body.stoppedSessions as string[] | undefined) ?? []) {
            closes.push({ sessionId, reason: 'owner_stopped' })
          }
          const sessionClose = closes.splice(0)
          return send(response, {
            commands: queue.filter((entry) => !entry.accepted).map((entry) => entry.envelope),
            cancellations: [], sessionClose,
          })
        }
        if (body.activeCommand) return send(response, { command: null, cancellation: null })
        const next = queue.find((entry) => !entry.accepted)
        // An older Nessie's envelope carries no session.
        const old = next && (({ sessionId: _s, agentName: _a, ...rest }) => rest)(next.envelope)
        return send(response, { command: old ?? null })
      }
      case '/api/executor-daemon/commands/receipt': {
        const receipt = body.receipt as { commandId: string; state: string }
        const entry = queue.find((candidate) => candidate.envelope.commandId === receipt.commandId)
        if (entry && receipt.state === 'accepted') entry.accepted = true
        if (entry && receipt.state === 'result_acknowledged') {
          queue.splice(queue.indexOf(entry), 1)
          entry.resolve(body.result as Record<string, unknown>)
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
  const run = (
    operationKey: ExecutorOperationKey, args: Record<string, unknown>, sessionId = SESSION,
  ): Promise<Record<string, unknown>> => new Promise((resolve) => {
    sequence += 1
    const payload = { args, runId: RUN_ID }
    const commandId = `00000000-0000-4000-8000-${String(0xf00 + sequence).padStart(12, '0')}`
    queue.push({
      accepted: false, resolve,
      envelope: {
        argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
        bindingFence: String(sequence), bindingId: '00000000-0000-4000-8000-000000000e05' as never,
        capabilityRevision: nessie.revision, commandId: commandId as never, expiresAt: '2099-01-01T00:00:00.000Z',
        idempotencyKey: commandId, operationKey, payload, sessionId: sessionId as never, agentName: 'Builder',
      },
    })
  })
  // The same object the routes update, so `revision` stays current.
  return Object.assign(nessie, { run, close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
}

const eventually = async (what: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const fixture = async (options: { strict?: boolean; programs?: boolean } = {}) => {
  const programs = options.programs ?? true
  const stateDir = await ensureOwnerOnlyStateDirectory(await mkdtemp(join(tmpdir(), 'nessie-sessions-state-')))
  const workspace = await mkdtemp(join(tmpdir(), 'nessie-sessions-workspace-'))
  await writeFile(join(workspace, 'report.md'), 'hello')
  const nessie = await startFakeNessie(options)
  const keys = generateKeyPairSync('ed25519')
  // command.run needs a guest VM configured; none starts, because nothing here is allowed to run.
  const state: ExecutorLocalState = {
    apiBaseUrl: nessie.apiBaseUrl,
    ...(programs ? { browserSandbox: {
      allowedOrigins: ['https://app.example.test'], guestInitrdBuilderPath: join(workspace, 'builder'),
      guestRuntimeBundlePath: join(workspace, 'runtime'), kernelPath: join(workspace, 'kernel'),
      vmHelperPath: join(workspace, 'helper'),
    } } : {}),
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [] },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: programs
        ? ['file.list', 'file.read', 'command.run', 'workspace.review', 'sandbox.stop']
        : ['file.list', 'file.read'],
      profiles: ['workspace_sandbox'],
      revision: 1, workspaceFolders: ['workspace'],
    },
    executorId: EXECUTOR_ID,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    workspaceFolders: [{ name: 'workspace', path: workspace }],
  }
  await saveExecutorState(stateDir, state)
  await writeFile(join(stateDir, 'existing-coding-sessions.json'), JSON.stringify({ enabled: false }))
  const liveness = new PassThrough()
  const running = serveExecutor(stateDir, state, { parentLiveness: liveness, runtime: {
    entry: packagedWindowsRun ? join(dirname(process.execPath), 'nessie-executor.cjs')
      : fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    execArgv: packagedWindowsRun ? [] : ['--import', 'tsx'],
    execPath: process.execPath, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  } })
  await eventually('the daemon has connected', () => nessie.revision > 0)
  return {
    stateDir, nessie,
    cleanup: async () => {
      liveness.end()
      await running
      await nessie.close()
      await rm(stateDir, { force: true, recursive: true })
      await rm(workspace, { force: true, recursive: true })
    },
  }
}

test('a program waiting for its owner holds only itself: a read in the same session finishes and the owner sees why', {
  skip: WINDOWS_STATE_HELPER_SKIP || NO_SANDBOX_SKIP, timeout: 60_000,
}, async () => {
  const { stateDir, nessie, cleanup } = await fixture()
  try {
    const program = nessie.run('command.run', { program: 'docker', args: ['build', '.'] })
    await eventually('the owner is asked', async () => (await listProgramRequests(stateDir)).length === 1)
    const [request] = await listProgramRequests(stateDir)
    assert.equal(request?.sessionId, SESSION)
    assert.equal(request?.agentName, 'Builder')

    const listed = await nessie.run('file.list', { path: 'workspace' })
    assert.equal(listed.success, true, 'the read finished while the program waits')
    await eventually('Nessie hears the command waits for the owner', () => nessie.polls.some((poll) =>
      (poll.waiting as Array<{ for: string }> | undefined)?.some((wait) => wait.for === 'owner') === true))
    // The list is rewritten just after the read's receipt.
    await eventually('the finished read leaves the list', async () => (await readSessions(stateDir))[0]?.commands.length === 1)
    const [session] = await readSessions(stateDir)
    assert.equal(session?.sessionId, SESSION)
    assert.equal(session?.agentName, 'Builder')
    const shown = session?.commands.map((command) => [command.kind, command.status, command.program, command.requestId])
    assert.deepEqual(shown, [['program', 'waiting_for_owner', 'docker', request?.id]])

    await writeProgramRequestAnswer(stateDir, request!.id, 'deny')
    const refused = await program
    assert.equal(refused.code, 'EXECUTOR_COMMAND_DENIED')
    assert.equal(refused.reason, 'owner_declined')
    await eventually('the list is empty again', async () => (await readSessions(stateDir)).length === 0)
  } finally {
    await cleanup()
  }
})

test('the owner\'s Stop ends one session\'s work, reaches Nessie, and is cleared when Nessie closes it', {
  skip: WINDOWS_STATE_HELPER_SKIP || NO_SANDBOX_SKIP, timeout: 60_000,
}, async () => {
  const { stateDir, nessie, cleanup } = await fixture()
  try {
    const stopped = nessie.run('command.run', { program: 'make', args: [] }, OTHER_SESSION)
    await eventually('the owner is asked', async () => (await listProgramRequests(stateDir)).length === 1)
    const out: string[] = []
    const code = await runSessionsCommand({ id: OTHER_SESSION, json: true, kind: 'session-stop', stateDir },
      (text) => { out.push(text) })
    assert.equal(code, 0, out.join(''))
    assert.deepEqual(JSON.parse(out.join('')), [], 'the session is gone from the list')

    const result = await stopped
    assert.equal(result.code, 'EXECUTOR_SESSION_STOPPED')
    assert.deepEqual(await listProgramRequests(stateDir), [], 'its request is withdrawn')
    await eventually('Nessie heard the stop', () => nessie.polls.some((poll) =>
      (poll.stoppedSessions as string[] | undefined)?.includes(OTHER_SESSION) === true))
    await eventually('Nessie closed it, and the stop is done', async () => (await listSessionStops(stateDir)).length === 0)

    // Another session was never touched.
    assert.equal((await nessie.run('file.list', { path: 'workspace' })).success, true)
  } finally {
    await cleanup()
  }
})

test('an older Nessie that refuses the concurrent poll still gets its work done, one command at a time', {
  skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000,
}, async () => {
  // Reads only: an older Nessie's one-at-a-time path needs no sandbox backend.
  const { nessie, cleanup } = await fixture({ programs: false, strict: true })
  try {
    const first = nessie.run('file.list', { path: 'workspace' })
    const second = nessie.run('file.read', { path: 'workspace/report.md' })
    assert.equal((await first).success, true)
    assert.equal((await second).success, true)
    const refusedAt = nessie.polls.findIndex((poll) => poll.concurrency !== undefined)
    assert.ok(refusedAt >= 0, 'the daemon asked in the concurrent shape first')
    assert.ok(nessie.polls.slice(refusedAt + 1).every((poll) => poll.concurrency === undefined),
      'then kept to the old shape for the connection')
  } finally {
    await cleanup()
  }
})
