import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { ScheduledTasks, SourceContracts as S } from '@nessie/t3-session-source/engine'
import { ExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import { executeSessionSchedule } from '../../dist/t3-session/control/schedules.js'

const request = method => Schema.decodeUnknownSync(ExecutorT3Request)({ transportVersion: 1, protocolVersion: 2,
  sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
  executorId: '11111111-1111-4111-8111-111111111111', environmentId: 'environment:雪',
  connectionEpoch: '1', runtimeGeneration: 'synthetic:runtime', correlationId: 'synthetic:call',
  relayOrdinal: 0, kind: 'request', commandId: 'schedule:original', method,
  input: { id: 'schedule:雪' },
})

test('schedule adapter has no default service, runtime, imported scheduler or automatic retry', async () => {
  const input = request('scheduledTasks.runNow')
  await assert.rejects(Effect.runPromise(executeSessionSchedule(input)), /ScheduledTaskService/u)
  let calls = 0
  await assert.rejects(Effect.runPromise(executeSessionSchedule(input).pipe(Effect.provide(
    Layer.mock(ScheduledTasks.ScheduledTaskService)({ runNow: value => {
      calls++
      assert.deepEqual(value, input.input)
      return Effect.fail(new S.ScheduledTaskError({ message: 'synthetic uncertain dispatch' }))
    } }),
  ))), /synthetic uncertain dispatch/u)
  assert.equal(calls, 1)
})

test('schedule mutation requires a transport id even though the original input has no command id', async () => {
  const input = request('scheduledTasks.delete')
  let calls = 0
  await assert.rejects(Effect.runPromise(executeSessionSchedule({ ...input, commandId: undefined }).pipe(Effect.provide(
    Layer.mock(ScheduledTasks.ScheduledTaskService)({ delete: () => {
      calls++; return Effect.die('invalid input reached the schedule writer')
    } }),
  ))), /T3_CONTROL_INPUT_REFUSED/u)
  assert.equal(calls, 0)
})
