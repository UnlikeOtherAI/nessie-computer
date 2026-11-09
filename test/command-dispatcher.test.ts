import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTOR_COMMAND_CANCELLED_RESULT,
  ExecutorCommandCancellationTargetSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { createCommandDispatcher, type CommandContext } from '../src/command-dispatcher.js'
import type { ExecutorCommandJournal, ExecutorCommandRecord } from '../src/command-journal.js'
import type { ExecutorCommandReceiptSender } from '../src/command-recovery.js'

const RUN_A = '00000000-0000-4000-8000-00000000a0a1'
const RUN_B = '00000000-0000-4000-8000-00000000a0b1'
const SESSION_A = '00000000-0000-4000-8000-00000000a0a2'
const SESSION_B = '00000000-0000-4000-8000-00000000a0b2'

let next = 0
const envelope = (
  operationKey: ExecutorCommandEnvelope['operationKey'], args: Record<string, unknown>,
  options: { runId?: string; sessionId?: string; agentName?: string } = {},
): ExecutorCommandEnvelope => {
  next += 1
  return {
    argumentDigest: `sha256:${'2'.repeat(64)}`, bindingFence: '1', bindingId: '00000000-0000-4000-8000-00000000c001',
    capabilityRevision: 1, commandId: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    expiresAt: '2099-01-01T00:00:00.000Z', idempotencyKey: `dispatch-${next}`, operationKey,
    payload: { args, runId: options.runId ?? RUN_A },
    sessionId: options.sessionId ?? SESSION_A,
    ...(options.agentName ? { agentName: options.agentName } : {}),
  } as ExecutorCommandEnvelope
}

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}.`)
}

/** Nessie's receipt rules, per command: accepted, started, then the result. */
const harness = (input: {
  execute: (command: ExecutorCommandEnvelope, context: CommandContext) => Promise<Record<string, unknown>>
  initial?: ExecutorCommandRecord[]
  paused?: () => boolean
  /** The first receipt in this state is lost on its way back. */
  loseFirst?: 'accepted' | 'started' | 'result_acknowledged'
}) => {
  const records = new Map((input.initial ?? []).map((record) => [record.command.commandId as string, record]))
  const states = new Map<string, string>()
  const results = new Map<string, Record<string, unknown>>()
  const ended: string[] = []
  const cancelled: string[] = []
  const journal: ExecutorCommandJournal = {
    list: async () => [...records.values()],
    remove: async (commandId) => { records.delete(commandId) },
    save: async (record) => { records.set(record.command.commandId, structuredClone(record)) },
  }
  const lost = new Set<string>()
  const receipt: ExecutorCommandReceiptSender = async ({ commandId, result, state }) => {
    const before = states.get(commandId) ?? 'leased'
    const order = ['leased', 'accepted', 'started', 'result_acknowledged']
    if (order.indexOf(state) !== order.indexOf(before) + 1 && state !== before) {
      throw new Error(`receipt ${state} after ${before}`)
    }
    states.set(commandId, state)
    if (result) results.set(commandId, result)
    if (input.loseFirst === state && !lost.has(commandId)) {
      lost.add(commandId)
      throw new Error(`response to ${state} lost`)
    }
  }
  let changes = 0
  const dispatcher = createCommandDispatcher({
    journal, receipt, execute: input.execute,
    cancelBackend: async (command) => { cancelled.push(command.commandId) },
    endRun: async (runId) => { ended.push(runId) },
    bridge: () => 'coding-sessions',
    paused: input.paused ?? (() => false),
    onChange: () => { changes += 1 },
    log: () => undefined,
  })
  const done = (command: ExecutorCommandEnvelope) => () => results.has(command.commandId)
  return { cancelled, changes: () => changes, dispatcher, done, ended, journal: records, results, states }
}

test('a file read completes while a program request waits for the owner, and only that command waits', async () => {
  const owner = deferred<boolean>()
  const program = envelope('command.run', { program: 'docker', args: ['build', '.'] }, { agentName: 'Sales agent' })
  const read = envelope('file.read', { path: 'workspace/report.md' })
  const ran: string[] = []
  const h = harness({
    execute: async (command, { ownerWait }) => {
      if (command.commandId === program.commandId) {
        ownerWait.begin('11111111-1111-4111-8111-111111111111')
        const allowed = await owner.promise
        await ownerWait.end(allowed)
        ran.push('docker')
        return { exitCode: 0, success: true }
      }
      ran.push('read')
      return { content: 'hello', success: true }
    },
  })
  await h.dispatcher.accept([program])
  await until(() => h.dispatcher.waiting().some((wait) => wait.for === 'owner'), 'the program request')
  await h.dispatcher.accept([read])
  await until(h.done(read), 'the file read')

  assert.deepEqual(ran, ['read'], 'the read finished while the program still waits')
  assert.deepEqual(h.dispatcher.waiting(), [{ commandId: program.commandId, for: 'owner' }])
  assert.equal(h.dispatcher.capacity().program, 4, 'a command waiting for the owner holds no slot')
  const [session] = h.dispatcher.sessions()
  assert.equal(session?.sessionId, SESSION_A)
  assert.equal(session?.agentName, 'Sales agent')
  assert.deepEqual(session?.commands, [{
    id: program.commandId, kind: 'program', status: 'waiting_for_owner', program: 'docker', args: ['build', '.'],
    requestId: '11111111-1111-4111-8111-111111111111',
  }])

  owner.resolve(true)
  await until(h.done(program), 'the allowed program')
  assert.deepEqual(ran, ['read', 'docker'])
  assert.deepEqual(h.results.get(program.commandId), { exitCode: 0, success: true })
  assert.equal(h.journal.size, 0)
  assert.equal(h.dispatcher.idle(), true)
})

test('two commands in one session run at the same time', async () => {
  const both = deferred()
  let running = 0
  let peak = 0
  const h = harness({
    execute: async () => {
      running += 1
      peak = Math.max(peak, running)
      if (running === 2) both.resolve()
      await both.promise
      running -= 1
      return { success: true }
    },
  })
  const first = envelope('file.read', { path: 'a.txt' })
  const second = envelope('mcp.call', { server: 'kelpie', tool: 'screenshot' })
  await h.dispatcher.accept([first, second])
  await until(() => h.done(first)() && h.done(second)(), 'both commands')
  assert.equal(peak, 2)
})

test('writes to the same path run one at a time, in arrival order; a write elsewhere does not wait', async () => {
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const order: string[] = []
  const h = harness({
    execute: async (command) => {
      const name = String((command.payload.args as { path: string }).path) + `#${command.idempotencyKey}`
      order.push(`start ${name}`)
      const gate = deferred()
      gates.set(command.commandId, gate)
      await gate.promise
      order.push(`end ${name}`)
      return { success: true }
    },
  })
  const one = envelope('file.write', { path: 'workspace/notes.md', content: '1' })
  const two = envelope('file.write', { path: 'workspace/./notes.md', content: '2' })
  const elsewhere = envelope('file.write', { path: 'workspace/other.md', content: '3' })
  await h.dispatcher.accept([one, two, elsewhere])
  await until(() => gates.has(one.commandId) && gates.has(elsewhere.commandId), 'the first write and the other path')
  assert.equal(gates.has(two.commandId), false, 'the second write to the same path waits')
  assert.deepEqual(h.dispatcher.waiting(), [{ commandId: two.commandId, for: 'start' }])
  assert.equal(h.dispatcher.sessions()[0]?.commands.find((command) => command.id === two.commandId)?.status, 'queued')

  gates.get(one.commandId)!.resolve()
  await until(() => gates.has(two.commandId), 'the second write')
  gates.get(two.commandId)!.resolve()
  gates.get(elsewhere.commandId)!.resolve()
  await until(() => [one, two, elsewhere].every((command) => h.done(command)()), 'every write')
  assert.ok(order.indexOf(`end workspace/notes.md#${one.idempotencyKey}`)
    < order.indexOf(`start workspace/./notes.md#${two.idempotencyKey}`))
})

test('after a restart each held command resumes, runs or reports on its own', async () => {
  const at = (command: ExecutorCommandEnvelope, phase: ExecutorCommandRecord['phase'], extra: Partial<ExecutorCommandRecord> = {}):
    ExecutorCommandRecord => ({ command, phase, receivedAt: '2026-11-08T10:00:00.000Z', version: 2, ...extra })
  const waiting = envelope('file.read', { path: 'w.txt' })
  const startedPending = envelope('file.read', { path: 's.txt' })
  const executing = envelope('command.run', { program: 'make', args: [] })
  const reporting = envelope('file.list', {})
  const executed: string[] = []
  const h = harness({
    initial: [
      at(waiting, 'waiting'), at(startedPending, 'started_pending'), at(executing, 'executing'),
      at(reporting, 'result_pending', { result: { entries: [], success: true } }),
    ],
    execute: async (command) => {
      executed.push(command.commandId)
      return { success: true }
    },
  })
  // Nessie's view of each: accepted, accepted, started, started.
  for (const command of [waiting, startedPending]) h.states.set(command.commandId, 'accepted')
  for (const command of [executing, reporting]) h.states.set(command.commandId, 'started')
  await h.dispatcher.start()
  await until(() => [waiting, startedPending, executing, reporting].every((command) => h.done(command)()), 'every record')

  assert.deepEqual(executed.sort(), [startedPending.commandId, waiting.commandId].sort())
  assert.deepEqual(h.results.get(executing.commandId), { code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME', success: false })
  assert.deepEqual(h.results.get(reporting.commandId), { entries: [], success: true })
  assert.equal(h.journal.size, 0)
})

test('Stop ends every command of one session, refuses its later work, and Nessie hears until it closes it', async () => {
  const hold = deferred()
  const h = harness({
    execute: async (_command, { signal }) => {
      await Promise.race([hold.promise, new Promise((resolve) => { signal.addEventListener('abort', resolve) })])
      return { success: true }
    },
  })
  const running = envelope('command.run', { program: 'npm', args: ['test'] })
  const queuedBehind = envelope('command.run', { program: 'npm', args: ['run', 'lint'] })
  const other = envelope('browser.open', { url: 'https://docs.example.com/start' }, { runId: RUN_B, sessionId: SESSION_B })
  await h.dispatcher.accept([running, queuedBehind, other])
  await until(() => h.dispatcher.waiting().length === 1, 'one sandbox command waiting behind the other')

  assert.equal(h.dispatcher.stopSession(SESSION_A), true)
  await until(() => h.done(running)() && h.done(queuedBehind)(), 'the stopped session')
  for (const command of [running, queuedBehind]) {
    assert.equal(h.results.get(command.commandId)?.code, 'EXECUTOR_SESSION_STOPPED')
  }
  assert.deepEqual(h.ended, [RUN_A], 'the session\'s sandbox ends')
  assert.equal(h.done(other)(), false, 'another session keeps running')
  assert.deepEqual(h.dispatcher.sessions().map((session) => [session.sessionId, session.commands[0]?.site]),
    [[SESSION_B, 'docs.example.com']])
  assert.deepEqual(h.dispatcher.stoppedSessions(), [SESSION_A])

  const late = envelope('file.read', { path: 'x' })
  await h.dispatcher.accept([late])
  await until(h.done(late), 'the late command')
  assert.equal(h.results.get(late.commandId)?.code, 'EXECUTOR_SESSION_STOPPED')

  h.dispatcher.closeSessions([{ sessionId: SESSION_A as never, reason: 'owner_stopped' }])
  assert.deepEqual(h.dispatcher.stoppedSessions(), [])
  const afterClose = envelope('file.read', { path: 'y' })
  await h.dispatcher.accept([afterClose])
  await until(h.done(afterClose), 'the command after the close')
  assert.equal(h.results.get(afterClose.commandId)?.code, 'EXECUTOR_SESSION_CLOSED')
  hold.resolve()
  await until(h.done(other), 'the other session')
  assert.deepEqual(h.results.get(other.commandId), { success: true })
})

test('Nessie closing a session cancels its held commands; a cancellation must name the command exactly', async () => {
  const h = harness({
    execute: async (_command, { signal }) => {
      await new Promise((resolve) => { signal.addEventListener('abort', resolve) })
      return { success: true }
    },
  })
  const command = envelope('coding.launch', { prompt: 'fix it' })
  const other = envelope('mcp.call', { server: 'kelpie', tool: 'look' }, { runId: RUN_B, sessionId: SESSION_B })
  await h.dispatcher.accept([command, other])
  await until(() => h.states.get(command.commandId) === 'started' && h.states.get(other.commandId) === 'started', 'both start')

  const target = ExecutorCommandCancellationTargetSchema.strip().parse(other)
  h.dispatcher.cancel([{ ...target, bindingFence: '2', requestedAt: new Date().toISOString() }])
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.done(other)(), false, 'a cancellation with another fence changes nothing')
  h.dispatcher.cancel([{ ...target, requestedAt: new Date().toISOString() }])
  await until(h.done(other), 'the cancelled command')
  assert.deepEqual(h.results.get(other.commandId), EXECUTOR_COMMAND_CANCELLED_RESULT)
  assert.deepEqual(h.cancelled, [other.commandId])

  h.dispatcher.closeSessions([{ sessionId: SESSION_A as never, reason: 'run_ended' }])
  await until(h.done(command), 'the closed session\'s command')
  assert.deepEqual(h.results.get(command.commandId), EXECUTOR_COMMAND_CANCELLED_RESULT)
  assert.deepEqual(h.ended, [RUN_A])
})

test('paused, the poll reports no free capacity', async () => {
  let paused = false
  const h = harness({ paused: () => paused, execute: async () => ({ success: true }) })
  assert.deepEqual(h.dispatcher.capacity(), { file: 16, program: 4, coding: 2, browser: 2, mcp: 8 })
  paused = true
  assert.deepEqual(h.dispatcher.capacity(), { file: 0, program: 0, coding: 0, browser: 0, mcp: 0 })
})

test('capacity counts held commands by kind, and the session limit queues the rest', async () => {
  const hold = deferred()
  const h = harness({ execute: async () => { await hold.promise; return { success: true } } })
  const runs = [1, 2, 3].map((index) => envelope('command.run', { program: 'sleep', args: [String(index)] }, {
    runId: `00000000-0000-4000-8000-00000000d00${index}`,
  }))
  await h.dispatcher.accept(runs)
  // Three runs in one session: two may run (the session's program limit), one waits to start.
  await until(() => h.dispatcher.waiting().length === 1, 'the session limit')
  assert.equal(h.dispatcher.capacity().program, 1, 'every held program command occupies its slot')
  assert.equal(h.dispatcher.activeCommands().length, 3)
  hold.resolve()
  await until(() => runs.every((command) => h.done(command)()), 'every run')
})

test('one command at a time while Nessie hands out one at a time', async () => {
  const gate = deferred()
  let running = 0
  let peak = 0
  const h = harness({
    execute: async () => {
      running += 1
      peak = Math.max(peak, running)
      await gate.promise
      running -= 1
      return { success: true }
    },
  })
  h.dispatcher.setMode('single')
  const first = envelope('file.read', { path: 'a' })
  const second = envelope('file.read', { path: 'b' }, { runId: RUN_B, sessionId: SESSION_B })
  await h.dispatcher.accept([first, second])
  await until(() => running === 1, 'the first command')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(peak, 1)
  gate.resolve()
  await until(() => h.done(first)() && h.done(second)(), 'both commands')
  assert.equal(peak, 1)
})

test('a receipt whose answer is lost is sent again later; the same delivery twice is held once', async () => {
  let executions = 0
  const h = harness({ loseFirst: 'started', execute: async () => { executions += 1; return { success: true } } })
  const command = envelope('file.read', { path: 'a' })
  // A lost poll answer makes Nessie deliver the same command again.
  await h.dispatcher.accept([command, command])
  await h.dispatcher.accept([command])
  await until(h.done(command), 'the command')
  assert.equal(executions, 1)
  assert.equal(h.states.get(command.commandId), 'result_acknowledged')
  await until(() => h.dispatcher.idle(), 'the record to be released')
})
