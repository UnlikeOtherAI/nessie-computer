import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { ExecutorApiError } from '../src/api-client.js'
import {
  createExecutorCommandRecoveryStore,
  recoverOrPollExecutorCommand,
  type ExecutorCommandRecovery,
  type ExecutorCommandRecoveryStore,
  type ExecutorCommandRecoveryTransport,
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
}

const memoryStore = (initial: ExecutorCommandRecovery | null = null): {
  read: () => ExecutorCommandRecovery | null
  store: ExecutorCommandRecoveryStore
} => {
  let value = initial
  return {
    read: () => value,
    store: {
      clear: async () => { value = null },
      load: async () => value,
      save: async (next) => { value = structuredClone(next) },
    },
  }
}

type ServerState = 'leased' | 'accepted' | 'started' | 'result_acknowledged' | 'unknown_outcome'

const fakeTransport = (options: {
  dropAfter?: 'accepted' | 'started' | 'result_acknowledged'
  initialState?: ServerState
} = {}): {
  pollCount: () => number
  result: () => Record<string, unknown> | undefined
  state: () => ServerState
  transport: ExecutorCommandRecoveryTransport
} => {
  let state: ServerState = options.initialState ?? 'leased'
  let delivered = false
  let polls = 0
  let result: Record<string, unknown> | undefined
  const receiptCalls = new Map<string, number>()
  return {
    pollCount: () => polls,
    result: () => result,
    state: () => state,
    transport: {
      poll: async () => {
        polls += 1
        if (delivered || state !== 'leased') return null
        delivered = true
        return command
      },
      receipt: async (receipt) => {
        const currentCalls = receiptCalls.get(receipt.state) ?? 0
        receiptCalls.set(receipt.state, currentCalls + 1)
        const same = state === receipt.state
        const valid = (
          (state === 'leased' && receipt.state === 'accepted')
          || (state === 'accepted' && receipt.state === 'started')
          || (state === 'started' && receipt.state === 'result_acknowledged')
          || (state === 'unknown_outcome' && receipt.state === 'result_acknowledged')
        )
        if (!same && !valid) {
          throw new ExecutorApiError('Receipt is out of order.', {
            code: 'EXECUTOR_COMMAND_REPLAY',
            status: 409,
          })
        }
        state = receipt.state
        if (receipt.result) result = receipt.result
        if (options.dropAfter === receipt.state && currentCalls === 0) {
          throw new Error(`response lost after ${receipt.state}`)
        }
      },
    },
  }
}

for (const lossPoint of ['accepted', 'started', 'result_acknowledged'] as const) {
  test(`client-recovery: lost ${lossPoint} response is replayed without repeated execution`, async () => {
    const journal = memoryStore()
    const server = fakeTransport({ dropAfter: lossPoint })
    let executions = 0
    const run = () => recoverOrPollExecutorCommand({
      execute: async () => {
        executions += 1
        return { exitCode: 0, output: 'done', success: true }
      },
      store: journal.store,
      transport: server.transport,
    })

    await assert.rejects(run(), new RegExp(`response lost after ${lossPoint}`))
    await run()

    assert.equal(server.state(), 'result_acknowledged')
    assert.equal(server.pollCount(), 1)
    assert.equal(executions, 1)
    assert.equal(journal.read(), null)
    assert.deepEqual(server.result(), { exitCode: 0, output: 'done', success: true })
  })
}

test('client-recovery: restart during execution reports unknown outcome without rerun', async () => {
  const journal = memoryStore({ command, phase: 'executing', version: 1 })
  const server = fakeTransport({ initialState: 'started' })
  let executions = 0
  await recoverOrPollExecutorCommand({
    execute: async () => {
      executions += 1
      return { success: true }
    },
    store: journal.store,
    transport: server.transport,
  })

  assert.equal(executions, 0)
  assert.equal(server.state(), 'result_acknowledged')
  assert.deepEqual(server.result(), {
    code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
    success: false,
  })
})

test('client-recovery: server timeout before execution resolves as unknown outcome', async () => {
  const journal = memoryStore({ command, phase: 'started_pending', version: 1 })
  const server = fakeTransport({ initialState: 'unknown_outcome' })
  let executions = 0
  await recoverOrPollExecutorCommand({
    execute: async () => {
      executions += 1
      return { success: true }
    },
    store: journal.store,
    transport: server.transport,
  })

  assert.equal(executions, 0)
  assert.equal(server.state(), 'result_acknowledged')
  assert.deepEqual(server.result(), {
    code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
    success: false,
  })
})

/**
 * The control plane's result check, as `recordExecutorCommandReceiptInTransaction`
 * applies it: a terminal result over its cap is refused as
 * `EXECUTOR_COMMAND_RESULT_INVALID`, and a refused receipt changes nothing.
 */
const refusingApi = (options: {
  loseResponseTo?: 'replacement'
  maxResultBytes: number
  refuseEverything?: boolean
}): {
  accepted: () => Record<string, unknown> | undefined
  sent: Record<string, unknown>[]
  transport: ExecutorCommandRecoveryTransport
} => {
  let state: ServerState = 'leased'
  let delivered = false
  let accepted: Record<string, unknown> | undefined
  let lost = false
  const sent: Record<string, unknown>[] = []
  return {
    accepted: () => accepted,
    sent,
    transport: {
      poll: async () => {
        if (delivered) return null
        delivered = true
        return command
      },
      receipt: async (receipt) => {
        if (receipt.state !== 'result_acknowledged') {
          state = receipt.state
          return
        }
        const result = receipt.result ?? {}
        sent.push(result)
        if (options.refuseEverything
          || Buffer.byteLength(JSON.stringify(result)) > options.maxResultBytes) {
          throw new ExecutorApiError('Executor result is invalid or exceeds its configured limit.', {
            code: 'EXECUTOR_COMMAND_RESULT_INVALID',
            status: 400,
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
      },
    },
  }
}

test('client-recovery: a result the control plane refuses is replaced by a small terminal failure', async () => {
  const journal = memoryStore()
  const saved: ExecutorCommandRecovery[] = []
  const store: ExecutorCommandRecoveryStore = {
    ...journal.store,
    save: async (next) => {
      saved.push(structuredClone(next))
      await journal.store.save(next)
    },
  }
  const api = refusingApi({ maxResultBytes: 1_024 })
  const refused: string[] = []
  let executions = 0
  await recoverOrPollExecutorCommand({
    execute: async () => {
      executions += 1
      return { output: 'x'.repeat(2_048), success: true }
    },
    onResultRefused: (refusedCommand) => { refused.push(refusedCommand.commandId) },
    store,
    transport: api.transport,
  })

  assert.equal(executions, 1, 'the command is never run again')
  assert.equal(api.sent.length, 2, 'the refused receipt is sent once, never retried')
  assert.deepEqual(api.accepted(), { code: 'EXECUTOR_RESULT_REFUSED', success: false })
  assert.deepEqual(refused, [command.commandId])
  // Journaled before it was sent, so a lost response replays the replacement.
  assert.deepEqual(saved.at(-1), {
    command,
    phase: 'result_pending',
    result: { code: 'EXECUTOR_RESULT_REFUSED', success: false },
    version: 1,
  })
  assert.equal(journal.read(), null, 'the lane is free for the next command')
})

test('client-recovery: a lost response to the replacement replays the replacement, not the refused result', async () => {
  const journal = memoryStore()
  const api = refusingApi({ loseResponseTo: 'replacement', maxResultBytes: 1_024 })
  const run = () => recoverOrPollExecutorCommand({
    execute: async () => ({ output: 'x'.repeat(2_048), success: true }),
    store: journal.store,
    transport: api.transport,
  })

  await assert.rejects(run(), /response lost after the replacement/)
  assert.deepEqual(journal.read()?.result, { code: 'EXECUTOR_RESULT_REFUSED', success: false })
  await run()

  assert.equal(api.sent.length, 3)
  assert.deepEqual(api.sent.slice(1), [
    { code: 'EXECUTOR_RESULT_REFUSED', success: false },
    { code: 'EXECUTOR_RESULT_REFUSED', success: false },
  ])
  assert.equal(journal.read(), null)
})

test('client-recovery: a refused replacement is not replaced again', async () => {
  const journal = memoryStore()
  const api = refusingApi({ maxResultBytes: 1_024, refuseEverything: true })
  await assert.rejects(recoverOrPollExecutorCommand({
    execute: async () => ({ success: true }),
    store: journal.store,
    transport: api.transport,
  }), { code: 'EXECUTOR_COMMAND_RESULT_INVALID' })

  assert.equal(api.sent.length, 2, 'one replacement, then the refusal surfaces')
  assert.deepEqual(journal.read()?.result, { code: 'EXECUTOR_RESULT_REFUSED', success: false })
})

test('client-recovery: any other receipt failure retries the same result', async () => {
  const journal = memoryStore({
    command,
    phase: 'result_pending',
    result: { exitCode: 0, output: 'done', success: true },
    version: 1,
  })
  const server = fakeTransport({ dropAfter: 'result_acknowledged', initialState: 'started' })
  const run = () => recoverOrPollExecutorCommand({
    execute: async () => ({ success: true }),
    store: journal.store,
    transport: server.transport,
  })

  await assert.rejects(run(), /response lost after result_acknowledged/)
  assert.deepEqual(journal.read()?.result, { exitCode: 0, output: 'done', success: true })
  await run()
  assert.deepEqual(server.result(), { exitCode: 0, output: 'done', success: true })
})

const withStateDirectory =async (body: (stateDir: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-command-recovery-'))
  try {
    await body(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

/**
 * The daemon polls once a second and used to build a recovery store per poll,
 * each of which re-secured the runtime directory. On POSIX that is an `lstat`;
 * on Windows it applies a DACL through the packaged native helper, so it was
 * two process spawns every second for as long as the daemon ran — the reason a
 * Windows executor burned roughly fifty times the CPU of its macOS counterpart
 * while both sat idle. One store now secures once, however many operations it
 * serves.
 *
 * Only `load` and `clear` are exercised, because `save` proves the journal file
 * itself owner-only and that proof is host-shaped; every operation derives the
 * path the same way, which is the thing under test.
 */
test('one recovery store secures its runtime directory once, not once per operation', async () => {
  await withStateDirectory(async (stateDir) => {
    let ensured = 0
    const store = createExecutorCommandRecoveryStore(stateDir, {
      ensureRuntimeDirectory: async (directory) => {
        ensured += 1
        return directory
      },
    })

    assert.equal(await store.load(), null)
    await store.clear()
    assert.equal(await store.load(), null)
    await store.clear()

    assert.equal(ensured, 1)
  })
})

/**
 * Securing once means caching the promise, which makes a rejected one
 * dangerous: cache that and a single transient failure would leave the daemon
 * unable to journal anything for the rest of its life, silently losing command
 * recovery. A failure must be attempted again on the next operation.
 */
test('a runtime directory that could not be secured is attempted again', async () => {
  await withStateDirectory(async (stateDir) => {
    let attempts = 0
    const store = createExecutorCommandRecoveryStore(stateDir, {
      ensureRuntimeDirectory: async (directory) => {
        attempts += 1
        if (attempts === 1) throw new Error('state security timed out')
        return directory
      },
    })

    await assert.rejects(store.load(), /state security timed out/)
    assert.equal(await store.load(), null)
    assert.equal(attempts, 2)
  })
})
