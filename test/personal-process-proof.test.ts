import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { cancelExecutorMcpProcessTree, stopExecutorMcpProcessTree } from '../src/mcp-command-process.js'
import { GuardedStdioTransport } from '../src/mcp-host-execution.js'

test('failed process tables and surviving descendants produce unknown, never a tree-stop proof', async () => {
  const failed = createCodingProcessControl('darwin', { ps: async () => undefined, termGraceMs: 0 })
  assert.equal(await failed.stopTree!({ pid: 999_999, startedAt: '100' }), 'unknown')
  const start = 'Tue Sep 23 10:00:00 2026'
  const rows = `999999 1 999999 ${start}\n999998 999999 999999 ${start}`
  const survived = createCodingProcessControl('darwin', { ps: async () => rows, termGraceMs: 0, signal: () => undefined })
  assert.equal(await survived.stopTree!({ pid: 999_999, startedAt: String(Date.UTC(2026, 8, 23, 10) / 1_000) }), 'unknown')
  await assert.rejects(stopExecutorMcpProcessTree(undefined, failed), /could not be proved/u)
  await assert.rejects(stopExecutorMcpProcessTree(undefined, failed, { pid: 999_999, startedAt: '100' }), /could not be proved/u)
})

test('ordinary MCP cancellation uses recorded identity without turning a sweep into custody proof', async () => {
  const identity = { pid: 999_999, startedAt: '100' }
  const control = createCodingProcessControl('darwin', { ps: async () => undefined })
  let killed = false
  control.identify = async () => { throw new Error('must retain the birth identity') }
  control.killTree = async (recorded) => { assert.deepEqual(recorded, identity); killed = true }
  control.stopTree = async () => { throw new Error('ordinary cancellation cannot request custody release') }
  await cancelExecutorMcpProcessTree(undefined, control, identity)
  assert.equal(killed, true)
  await assert.rejects(stopExecutorMcpProcessTree(undefined, control, identity), /cannot request custody release/u)
})

test('an emptied POSIX group and visible tree still cannot prove escaped descendants stopped', async () => {
  const start = 'Tue Sep 23 10:00:00 2026'
  let reads = 0
  const signals: number[] = []
  const control = createCodingProcessControl('darwin', { termGraceMs: 0,
    ps: async () => ++reads === 1 ? `999999 1 999999 ${start}` : `1 0 1 ${start}`,
    signal: (pid) => { signals.push(pid) },
  })
  assert.equal(await control.stopTree!({ pid: 999_999, startedAt: String(Date.UTC(2026, 8, 23, 10) / 1_000) }), 'unknown')
  assert.ok(signals.includes(-999_999), 'the operational group sweep still runs')
  assert.ok(reads >= 3, 'absence was confirmed by a fresh table after signalling')
})

test('a local app\'s transport records the generation it started as', async () => {
  const control = createCodingProcessControl()
  control.identify = async (pid) => ({ pid, startedAt: '100' })
  const transport = new GuardedStdioTransport({ command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 600000)'], stderr: 'ignore' }, control)
  try {
    await transport.start()
    assert.deepEqual(transport.processIdentity, { pid: transport.pid, startedAt: '100' })
  } finally { await transport.close() }
})
