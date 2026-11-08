import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeExecutorT3ToolInput, executorT3ToolInputSchema, executorT3ToolOperations,
  executorT3HistoryTools,
} from '@nessie/executor-protocol/t3-session'

const executorId = '38e32aef-a7a4-49c1-95e4-87b38d83f4bf'
const environmentId = 'environment:český/原本'
const threadId = 'mcp:thread/český:原本'
const commandId = 'command:stejný/原本'
const operations = executorT3ToolOperations()
const named = (name: string) => {
  const operation = operations.find(entry => entry.name === name)
  assert.ok(operation, name)
  return operation
}

test('named tools bind original operations and omit arbitrary command and secret dispatch', () => {
  assert.equal(new Set(operations.map(operation => operation.name)).size, operations.length)
  assert.ok(operations.length > 100)
  assert.ok(!operations.some(operation => operation.name === 't3_session_rpc_orchestration_dispatchCommand'))
  assert.ok(!operations.some(operation => operation.command === 'runtime-request.respond'))
  assert.ok(!operations.some(operation => String(operation.method) === 'secrets.answerRequest'))
  assert.ok(!operations.some(operation => operation.name.includes('usage')))
  assert.equal(named('t3_session_rpc_orchestration_searchThreadStream').kind, 'stream')
  assert.equal(named('t3_session_rpc_orchestration_getThreadFamily').authority, 'read')
  assert.equal(named('t3_session_command_thread_stop').authority, 'operate')
})

test('same operation input preserves original IDs and deterministic replay identity', () => {
  const operation = named('t3_session_command_thread_stop')
  const args = { executorId, environmentId, commandId, input: { type: 'thread.stop', commandId, threadId } }
  const first = decodeExecutorT3ToolInput(operation, args)
  assert.deepEqual(decodeExecutorT3ToolInput(operation, args), first)
  assert.equal(first.environmentId, environmentId)
  assert.equal(first.commandId, commandId)
  assert.equal(first.method, 'orchestration.dispatchCommand')
  assert.deepEqual(first.input, args.input)
  // This checks input identity, not a broker admission or provider receipt.
})

test('wrong command, missing or mismatched operation IDs and injected authority fail closed', () => {
  const operation = named('t3_session_command_thread_stop')
  const valid = { executorId, environmentId, commandId, input: { type: 'thread.stop', commandId, threadId } }
  for (const args of [
    { ...valid, commandId: undefined },
    { ...valid, commandId: 'different' },
    { ...valid, input: { ...valid.input, type: 'thread.archive' } },
    { ...valid, authorityRef: 'invented' },
    { ...valid, connectionEpoch: '123' },
    { ...valid, runtimeGeneration: 'invented' },
    { ...valid, method: 'secrets.answerRequest' },
  ]) assert.throws(() => decodeExecutorT3ToolInput(operation, args), /^Error: T3_TOOL_INPUT_REJECTED$/)
})

test('invalid input never includes supplied content in diagnostics', () => {
  const operation = named('t3_session_command_thread_stop')
  const canary = 'synthetic-sensitive-český-123'
  assert.throws(() => decodeExecutorT3ToolInput(operation, { input: { secret: canary } }), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'T3_TOOL_INPUT_REJECTED')
    assert.ok(!JSON.stringify(error).includes(canary))
    assert.equal(error.cause, undefined)
    return true
  })
})

test('tool schemas retain named input and exclude broker credentials and fences', () => {
  const schema = executorT3ToolInputSchema(named('t3_session_command_thread_stop'))
  const properties = schema.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties).sort(), ['commandId', 'environmentId', 'executorId', 'input'])
  assert.equal(schema.additionalProperties, false)
  assert.ok(properties.input)
})

test('all original finite HTTP history doors retain separate endpoint identity', () => {
  const history = executorT3HistoryTools()
  assert.deepEqual(history.map(tool => tool.endpoint).sort(), [
    'shellSnapshot', 'threadBoundedSnapshot', 'threadHistoryPage', 'threadSnapshot', 'threadTranscript',
  ])
  assert.ok(history.every(tool => tool.kind === 'finite' && tool.authority === 'read'))
  assert.ok(history.every(tool => !('headers' in tool.inputCodec.fields)))
})
