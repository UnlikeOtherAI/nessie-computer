import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalExecutorJson, type ExecutorCodingSessionsFacts, type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { CODING_SESSIONS_CONFIG_DIGEST_ENV } from '../src/coding-session/config.js'

import { localCommandPolicyPermits, localTerminalCommandRefusal, type LocalCommandPolicy } from '../src/command-policy.js'
import type { ExecutorCommandSessionManager } from '../src/command-session-manager.js'
import { executeExecutorCommand } from '../src/daemon.js'
import { createDaemonLiveState, liveView } from '../src/daemon-live-state.js'
import type { ExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import { answerProgramRequest } from '../src/program-request-cli.js'
import { createProgramRequestGate } from '../src/program-request-gate.js'
import {
  listProgramRequests,
  openProgramRequestStore,
  writeProgramRequestAnswer,
  type ProgramRequest,
} from '../src/program-requests.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const skip = WINDOWS_STATE_HELPER_SKIP
const runId = '00000000-0000-4000-8000-000000000a01'
const executorId = '00000000-0000-4000-8000-000000000a02'
const rules = (allowlist: string[], denylist: string[] = []): LocalCommandPolicy => ({ mode: 'allowlist', allowlist, denylist })

const envelope = (
  operationKey: 'command.run' | 'mcp.call', args: Record<string, unknown>, expiresAt = '2099-01-01T00:00:00.000Z',
): ExecutorCommandEnvelope => {
  const payload = { args, runId }
  return {
    argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
    bindingFence: '1', bindingId: '00000000-0000-4000-8000-000000000a03' as never, capabilityRevision: 1,
    commandId: '00000000-0000-4000-8000-000000000a04' as never, expiresAt, idempotencyKey: `request-${operationKey}`,
    operationKey, payload,
  }
}

const stateWith = (commandPolicy: LocalCommandPolicy, extra: Partial<ExecutorLocalState> = {}): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'], guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime', kernelPath: '/private/kernel', vmHelperPath: '/private/helper',
  },
  commandPolicy,
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['command.run', 'mcp.tools', 'mcp.call'], profiles: ['workspace_sandbox'], revision: 1,
  },
  executorId, machinePrivateKey: 'private', machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
  ...extra,
})

const stateDirectory = async (): Promise<string> =>
  ensureOwnerOnlyStateDirectory(await mkdtemp(join(tmpdir(), 'nessie-program-requests-')))

/** The owner, on this computer: waits for the one request and answers it. */
const ownerAnswers = async (
  stateDir: string, answer: (request: ProgramRequest) => Promise<void>,
): Promise<ProgramRequest> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [request] = await listProgramRequests(stateDir)
    if (request) {
      await answer(request)
      return request
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('No program request appeared.')
}

/** A command session manager that, like the real one, checks the rules again — through the daemon's view. */
const sessionsOver = (live: ReturnType<typeof createDaemonLiveState>) => {
  const ran: string[] = []
  const sessions = {
    run: async (command: ExecutorCommandEnvelope) => {
      const { program, args } = command.payload.args as { program: string; args: string[] }
      if (!localCommandPolicyPermits(live.view, program, args)) return { code: 'EXECUTOR_COMMAND_DENIED', success: false }
      ran.push([program, ...args].join(' '))
      return { exitCode: 0, success: true }
    },
  } as unknown as ExecutorCommandSessionManager
  return { ran, sessions }
}

const admissionFor = (stateDir: string, live: ReturnType<typeof createDaemonLiveState>, now?: () => number) => ({
  gate: createProgramRequestGate({ store: openProgramRequestStore(stateDir), pollMs: 10, ...(now ? { now } : {}),
    log: () => undefined }),
  allowOnce: live.allowOnce,
})

test('a command refused only as not allowed runs once when the owner allows it once, and nothing is saved', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    const live = createDaemonLiveState(stateWith(rules(['git *'])))
    const { ran, sessions } = sessionsOver(live)
    const result = executeExecutorCommand(stateDir, live.current, envelope('command.run', { program: 'ls', args: ['-la'] }), {
      commandSessions: sessions, programRequests: admissionFor(stateDir, live),
    })
    const request = await ownerAnswers(stateDir, (waiting) => writeProgramRequestAnswer(stateDir, waiting.id, 'once'))
    assert.equal(request.program, 'ls')
    assert.deepEqual(request.args, ['-la'])
    assert.ok(Date.parse(request.expiresAt) - Date.parse(request.requestedAt) <= 120_000)
    assert.deepEqual(await result, { exitCode: 0, success: true })
    assert.deepEqual(ran, ['ls -la'])
    // The loan ended with the launch, and the request is gone.
    assert.deepEqual(live.commandRules.allowlist, ['git *'])
    assert.deepEqual(await readdir(join(stateDir, 'program-requests')), [])
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('the owner declining refuses the launch and it never reaches a session', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    const live = createDaemonLiveState(stateWith(rules(['git *'])))
    const { ran, sessions } = sessionsOver(live)
    const result = executeExecutorCommand(stateDir, live.current, envelope('command.run', { program: 'ls', args: [] }), {
      commandSessions: sessions, programRequests: admissionFor(stateDir, live),
    })
    await ownerAnswers(stateDir, (waiting) => writeProgramRequestAnswer(stateDir, waiting.id, 'deny'))
    const refused = await result
    assert.equal(refused.code, 'EXECUTOR_COMMAND_DENIED')
    assert.equal(refused.reason, 'owner_declined')
    assert.deepEqual(ran, [])
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('no answer before the hold ends refuses the launch as owner_did_not_answer', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    const live = createDaemonLiveState(stateWith(rules([])))
    const { ran, sessions } = sessionsOver(live)
    // Each look at the clock moves it a minute on: the 120-second cap passes on the third.
    let clock = Date.now()
    const result = await executeExecutorCommand(stateDir, live.current, envelope('command.run', { program: 'ls', args: [] }), {
      commandSessions: sessions, programRequests: admissionFor(stateDir, live, () => (clock += 60_000) - 60_000),
    })
    assert.equal(result.code, 'EXECUTOR_COMMAND_DENIED')
    assert.equal(result.reason, 'owner_did_not_answer')
    assert.deepEqual(ran, [])
    assert.deepEqual(await listProgramRequests(stateDir), [])
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a denied program, or a command about to expire, is refused at once and nobody is asked', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    const live = createDaemonLiveState(stateWith(rules([], ['rm *'])))
    const { sessions } = sessionsOver(live)
    const options = { commandSessions: sessions, programRequests: admissionFor(stateDir, live) }
    assert.deepEqual(await executeExecutorCommand(stateDir, live.current,
      envelope('command.run', { program: 'rm', args: ['-rf', 'x'] }), options),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false })
    const soon = new Date(Date.now() + 8_000).toISOString()
    assert.deepEqual(await executeExecutorCommand(stateDir, live.current,
      envelope('command.run', { program: 'ls', args: [] }, soon), options),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false })
    await assert.rejects(readdir(join(stateDir, 'program-requests')), { code: 'ENOENT' })
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('always saves "<program> *" through the policy writer before the waiting launch hears it', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    const keys = generateKeyPairSync('ed25519')
    const saved = stateWith(rules(['git *']), {
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        operationKeys: ['file.list', 'file.read'], profiles: ['workspace_sandbox'], revision: 4,
      },
      machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      workspaceFolders: [{ name: 'workspace', path: stateDir }],
    })
    delete saved.browserSandbox
    await saveExecutorState(stateDir, saved)
    const gate = createProgramRequestGate({ store: openProgramRequestStore(stateDir), pollMs: 10, log: () => undefined })
    const verdict = gate.ask({ program: 'pnpm', args: ['install'], expiresAt: '2099-01-01T00:00:00.000Z' })
    await ownerAnswers(stateDir, async (waiting) => {
      await answerProgramRequest(stateDir, await loadExecutorState(stateDir), { answer: 'always', id: waiting.id, json: false },
        () => undefined)
    })
    assert.deepEqual(await verdict, { allowed: true, answer: 'always' })
    const after = await loadExecutorState(stateDir)
    assert.deepEqual(after.commandPolicy?.allowlist, ['git *', 'pnpm *'])
    assert.equal(after.descriptor.revision, 5)
    // A request already answered, or one that never existed, cannot be answered again.
    await assert.rejects(answerProgramRequest(stateDir, after, { answer: 'once', id: '00000000-0000-4000-8000-000000000a09',
      json: false }, () => undefined), /no longer waiting/u)
    await assert.rejects(answerProgramRequest(stateDir, after, { answer: 'once', id: '../escape', json: false },
      () => undefined), /program request id/u)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a terminal launch refused as not allowlisted is asked about, and the bridge gets the lent rule', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    const bridge = {
      name: 'coding-sessions',
      command: [process.execPath, 'bridge.mjs', 'serve-coding-session-mcp', '--config', join(stateDir, 'c.json')],
      env: { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: `sha256:${'c'.repeat(64)}` },
    }
    const facts: ExecutorCodingSessionsFacts = {
      serverName: 'coding-sessions', agents: ['claude'], permissionMode: { claude: 'acceptEdits' },
      allowedToolCount: 0, environmentNames: [], rootNames: ['nessie'], configDigest: `sha256:${'c'.repeat(64)}`,
    }
    const live = createDaemonLiveState(stateWith(rules(['claude *']), {
      descriptor: {
        codingSessions: facts, limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        mcpServers: ['coding-sessions'], operationKeys: ['mcp.tools', 'mcp.call'], profiles: ['workspace_sandbox'], revision: 1,
      },
      mcpServers: [bridge],
    }))
    const stamped = liveView(() => live.commandRules)
    const launched: string[][] = []
    const mcpSessions = {
      callTool: async (_server: string, _tool: string, args: { command: string[] }, meta: Record<string, unknown>) => {
        // What crosses to the bridge is serialized at the call, as the MCP transport does.
        const sent = JSON.parse(JSON.stringify(meta['nessie/command-rules'])) as LocalCommandPolicy
        if (localTerminalCommandRefusal(sent, args.command)) return { code: 'coding_session_command_refused', success: false }
        launched.push(args.command)
        return { success: true }
      },
    } as unknown as ExecutorMcpSessionManager
    const call = envelope('mcp.call', {
      server: 'coding-sessions', tool: 'session_start', arguments: { agent: 'terminal', command: ['htop', '-d', '5'] },
    })
    const result = executeExecutorCommand(stateDir, live.current, call, {
      mcpSessions, codingBridge: { callMeta: () => ({ 'nessie/command-rules': stamped }) },
      programRequests: admissionFor(stateDir, live),
    })
    const request = await ownerAnswers(stateDir, (waiting) => writeProgramRequestAnswer(stateDir, waiting.id, 'once'))
    assert.deepEqual([request.program, ...request.args], ['htop', '-d', '5'])
    assert.deepEqual(await result, { success: true })
    assert.deepEqual(launched, [['htop', '-d', '5']])
    assert.deepEqual(JSON.parse(JSON.stringify(stamped)).allowlist, ['claude *'])
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})
