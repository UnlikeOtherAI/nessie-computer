import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { ExecutorApiError } from '../src/api-client.js'
import {
  createExecutorCommandJournal,
  type ExecutorCommandJournal,
  type ExecutorCommandRecord,
} from '../src/command-journal.js'
import { replaceOwnerOnlyText } from '../src/owner-only-json.js'
import {
  advanceExecutorCommand,
  type ExecutorCommandLifecycle,
  type ExecutorCommandReceiptSender,
} from '../src/command-recovery.js'

const command: ExecutorCommandEnvelope = {
  argumentDigest: `sha256:${'1'.repeat(64)}`,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000502',
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000503',
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'command-recovery-test',
  operationKey: 'command.run',
  payload: { args: { args: ['test'], program: 'pnpm' }, runId: '00000000-0000-4000-8000-000000000501' },
} as ExecutorCommandEnvelope

const RECEIVED = '2026-11-08T10:00:00.000Z'
const arrived = (phase: ExecutorCommandRecord['phase'] = 'accepted_pending', extra: Partial<ExecutorCommandRecord> = {}):
  ExecutorCommandRecord => ({ command, phase, receivedAt: RECEIVED, version: 2, ...extra })

const memoryJournal = (initial: ExecutorCommandRecord[] = []) => {
  const records = new Map(initial.map((record) => [record.command.commandId as string, structuredClone(record)]))
  const saved: ExecutorCommandRecord[] = []
  const journal: Pick<ExecutorCommandJournal, 'remove' | 'save'> = {
    remove: async (commandId) => { records.delete(commandId) },
    save: async (record) => {
      saved.push(structuredClone(record))
      records.set(record.command.commandId, structuredClone(record))
    },
  }
  return { journal, read: (id: string = command.commandId) => records.get(id) ?? null, saved }
}

type ServerState = 'leased' | 'accepted' | 'started' | 'result_acknowledged' | 'unknown_outcome'

const fakeServer = (options: { dropAfter?: 'accepted' | 'started' | 'result_acknowledged'; initialState?: ServerState } = {}) => {
  let state: ServerState = options.initialState ?? 'leased'
  let result: Record<string, unknown> | undefined
  const calls = new Map<string, number>()
  const receipt: ExecutorCommandReceiptSender = async (input) => {
    const count = calls.get(input.state) ?? 0
    calls.set(input.state, count + 1)
    const valid = state === input.state
      || (state === 'leased' && input.state === 'accepted')
      || (state === 'accepted' && input.state === 'started')
      || (state === 'started' && input.state === 'result_acknowledged')
      || (state === 'unknown_outcome' && input.state === 'result_acknowledged')
    if (!valid) throw new ExecutorApiError('Receipt is out of order.', { code: 'EXECUTOR_COMMAND_REPLAY', status: 409 })
    state = input.state
    if (input.result) result = input.result
    if (options.dropAfter === input.state && count === 0) throw new Error(`response lost after ${input.state}`)
  }
  return { receipt, result: () => result, state: () => state }
}

const lifecycle = (
  journal: Pick<ExecutorCommandJournal, 'remove' | 'save'>, receipt: ExecutorCommandReceiptSender,
  execute: () => Promise<Record<string, unknown>>, extra: Partial<ExecutorCommandLifecycle> = {},
): ExecutorCommandLifecycle => ({
  journal, receipt, admit: async () => ({ release: () => undefined }), execute, ...extra,
})

for (const lossPoint of ['accepted', 'started', 'result_acknowledged'] as const) {
  test(`client-recovery: lost ${lossPoint} response is replayed without repeated execution`, async () => {
    const memory = memoryJournal([arrived()])
    const server = fakeServer({ dropAfter: lossPoint })
    let executions = 0
    const run = () => advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
      executions += 1
      return { exitCode: 0, output: 'done', success: true }
    }))

    await assert.rejects(run(), new RegExp(`response lost after ${lossPoint}`))
    await run()

    assert.equal(server.state(), 'result_acknowledged')
    assert.equal(executions, 1)
    assert.equal(memory.read(), null)
    assert.deepEqual(server.result(), { exitCode: 0, output: 'done', success: true })
  })
}

test('client-recovery: restart during execution reports unknown outcome without rerun', async () => {
  const memory = memoryJournal([arrived('executing')])
  const server = fakeServer({ initialState: 'started' })
  let executions = 0
  await advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
    executions += 1
    return { success: true }
  }))

  assert.equal(executions, 0)
  assert.equal(server.state(), 'result_acknowledged')
  assert.deepEqual(server.result(), { code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME', success: false })
})

test('client-recovery: server timeout before execution resolves as unknown outcome', async () => {
  const memory = memoryJournal([arrived('started_pending')])
  const server = fakeServer({ initialState: 'unknown_outcome' })
  let executions = 0
  await advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
    executions += 1
    return { success: true }
  }))

  assert.equal(executions, 0)
  assert.deepEqual(server.result(), { code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME', success: false })
})

test('client-recovery: a command waiting to start resumes waiting after a restart and then runs once', async () => {
  const memory = memoryJournal([arrived('waiting')])
  const server = fakeServer({ initialState: 'accepted' })
  const admitted: string[] = []
  let executions = 0
  await advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
    executions += 1
    return { success: true }
  }, { admit: async (record) => { admitted.push(record.phase); return { release: () => undefined } } }))

  assert.deepEqual(admitted, ['waiting'])
  assert.equal(executions, 1)
  assert.equal(server.state(), 'result_acknowledged')
})

test('client-recovery: a command ended while it waited is started and reported without running', async () => {
  const memory = memoryJournal([arrived()])
  const server = fakeServer()
  let executions = 0
  await advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
    executions += 1
    return { success: true }
  }, { admit: async () => ({ result: { code: 'EXECUTOR_SESSION_STOPPED', success: false } }) }))

  assert.equal(executions, 0)
  assert.deepEqual(server.result(), { code: 'EXECUTOR_SESSION_STOPPED', success: false })
})

test('client-recovery: the slot is given back when execution fails part-way', async () => {
  const memory = memoryJournal([arrived()])
  const server = fakeServer()
  let released = 0
  await assert.rejects(advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
    throw new Error('backend broke')
  }, { admit: async () => ({ release: () => { released += 1 } }) })), /backend broke/u)
  assert.equal(released, 1)
})

/**
 * The control plane's result check, as `recordExecutorCommandReceiptInTransaction`
 * applies it: a terminal result over its cap is refused as
 * `EXECUTOR_COMMAND_RESULT_INVALID`, and a refused receipt changes nothing.
 */
const refusingServer = (options: { loseResponseTo?: 'replacement'; maxResultBytes: number; refuseEverything?: boolean }) => {
  let state: ServerState = 'leased'
  let accepted: Record<string, unknown> | undefined
  let lost = false
  const sent: Record<string, unknown>[] = []
  const receipt: ExecutorCommandReceiptSender = async (input) => {
    if (input.state !== 'result_acknowledged') {
      state = input.state
      return
    }
    const result = input.result ?? {}
    sent.push(result)
    if (options.refuseEverything || Buffer.byteLength(JSON.stringify(result)) > options.maxResultBytes) {
      throw new ExecutorApiError('Executor result is invalid or exceeds its configured limit.', {
        code: 'EXECUTOR_COMMAND_RESULT_INVALID', status: 400,
      })
    }
    if (state === 'result_acknowledged') return
    assert.equal(state, 'started')
    state = 'result_acknowledged'
    accepted = result
    if (options.loseResponseTo === 'replacement' && !lost) {
      lost = true
      throw new Error('response lost after the replacement')
    }
  }
  return { accepted: () => accepted, receipt, sent }
}

test('client-recovery: a result the control plane refuses is replaced by a small terminal failure', async () => {
  const memory = memoryJournal([arrived()])
  const server = refusingServer({ maxResultBytes: 1_024 })
  const refused: string[] = []
  let executions = 0
  await advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt, async () => {
    executions += 1
    return { output: 'x'.repeat(2_048), success: true }
  }, { onResultRefused: (refusedCommand) => { refused.push(refusedCommand.commandId) } }))

  assert.equal(executions, 1, 'the command is never run again')
  assert.equal(server.sent.length, 2, 'the refused receipt is sent once, never retried')
  assert.deepEqual(server.accepted(), { code: 'EXECUTOR_RESULT_REFUSED', success: false })
  assert.deepEqual(refused, [command.commandId])
  // Journaled before it was sent, so a lost response replays the replacement.
  assert.deepEqual(memory.saved.at(-1)?.result, { code: 'EXECUTOR_RESULT_REFUSED', success: false })
  assert.equal(memory.read(), null, 'the record is released')
})

test('client-recovery: a lost response to the replacement replays the replacement, not the refused result', async () => {
  const memory = memoryJournal([arrived()])
  const server = refusingServer({ loseResponseTo: 'replacement', maxResultBytes: 1_024 })
  const run = () => advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt,
    async () => ({ output: 'x'.repeat(2_048), success: true })))

  await assert.rejects(run(), /response lost after the replacement/)
  assert.deepEqual(memory.read()?.result, { code: 'EXECUTOR_RESULT_REFUSED', success: false })
  await run()

  assert.deepEqual(server.sent.slice(1), [
    { code: 'EXECUTOR_RESULT_REFUSED', success: false },
    { code: 'EXECUTOR_RESULT_REFUSED', success: false },
  ])
  assert.equal(memory.read(), null)
})

test('client-recovery: a refused replacement is not replaced again', async () => {
  const memory = memoryJournal([arrived()])
  const server = refusingServer({ maxResultBytes: 1_024, refuseEverything: true })
  await assert.rejects(advanceExecutorCommand(memory.read()!, lifecycle(memory.journal, server.receipt,
    async () => ({ success: true }))), { code: 'EXECUTOR_COMMAND_RESULT_INVALID' })

  assert.equal(server.sent.length, 2, 'one replacement, then the refusal surfaces')
  assert.deepEqual(memory.read()?.result, { code: 'EXECUTOR_RESULT_REFUSED', success: false })
})

const withStateDirectory = async (body: (stateDir: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-command-recovery-'))
  try {
    await body(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const unsecured = { ensureRuntimeDirectory: async (directory: string) => directory, log: () => undefined }

/**
 * The daemon used to build a recovery store per poll, each of which
 * re-secured the runtime directory — on Windows two native-helper spawns a
 * second. One journal secures once, however many operations it serves.
 */
test('one journal secures its runtime directory once, not once per operation', async () => {
  await withStateDirectory(async (stateDir) => {
    let ensured = 0
    const journal = createExecutorCommandJournal(stateDir, {
      ...unsecured, ensureRuntimeDirectory: async (directory) => { ensured += 1; return directory },
    })
    assert.deepEqual(await journal.list(), [])
    await journal.remove(command.commandId)
    assert.deepEqual(await journal.list(), [])
    assert.equal(ensured, 1)
  })
})

test('a runtime directory that could not be secured is attempted again', async () => {
  await withStateDirectory(async (stateDir) => {
    let attempts = 0
    const journal = createExecutorCommandJournal(stateDir, {
      ...unsecured,
      ensureRuntimeDirectory: async (directory) => {
        attempts += 1
        if (attempts === 1) throw new Error('state security timed out')
        return directory
      },
    })
    await assert.rejects(journal.list(), /state security timed out/)
    assert.deepEqual(await journal.list(), [])
    assert.equal(attempts, 2)
  })
})

const second = { ...command, commandId: '00000000-0000-4000-8000-000000000504', operationKey: 'file.read' } as ExecutorCommandEnvelope

test('the journal keeps one record per command, oldest first, and an older daemon\'s journal is taken over', async () => {
  await withStateDirectory(async (stateDir) => {
    await replaceOwnerOnlyText(join(stateDir, 'command-recovery.json'), `${JSON.stringify({
      command, phase: 'started_pending', version: 1,
    })}\n`)
    const journal = createExecutorCommandJournal(stateDir, unsecured)
    await journal.save({ command: second, phase: 'waiting', receivedAt: '2000-01-01T00:00:00.000Z', version: 2 })

    const held = await journal.list()
    assert.deepEqual(held.map((record) => [record.command.commandId, record.phase]), [
      [second.commandId, 'waiting'],
      [command.commandId, 'started_pending'],
    ])
    assert.deepEqual((await readdir(stateDir)).filter((name) => name === 'command-recovery.json'), [],
      'the old journal is gone once its command has a record of its own')

    await journal.remove(second.commandId)
    assert.deepEqual((await journal.list()).map((record) => record.command.commandId), [command.commandId])
  })
})

test('a damaged record is set aside and holds no other command', async () => {
  await withStateDirectory(async (stateDir) => {
    const logged: string[] = []
    const journal = createExecutorCommandJournal(stateDir, { ...unsecured, log: (message) => { logged.push(message) } })
    await journal.save(arrived('waiting'))
    await mkdir(join(stateDir, 'command-recovery'), { recursive: true })
    await replaceOwnerOnlyText(join(stateDir, 'command-recovery', `${second.commandId}.json`), '{"version":2}')

    assert.deepEqual((await journal.list()).map((record) => record.command.commandId), [command.commandId])
    assert.equal(logged.length, 1)
    assert.ok((await readdir(join(stateDir, 'command-recovery'))).includes(`${second.commandId}.json.unreadable`))
  })
})
