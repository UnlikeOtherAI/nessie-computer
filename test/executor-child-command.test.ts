import assert from 'node:assert/strict'
import test from 'node:test'
import { executorChildCommand } from '../src/executor-child-command.js'

const directory = `/usr/lib/nessie-executor/releases/${'a'.repeat(64)}`
const runtime = { execPath: `${directory}/nessie-executor-runtime`, execArgv: [],
  entry: `${directory}/nessie-executor.cjs`, packaged: true }

test('compiled managed Linux children use the retained release native launcher', () => {
  assert.deepEqual(executorChildCommand(runtime, ['serve-coding-session-mcp', '--config', '/private/config'], 'linux'),
    [`${directory}/nessie-executor-native`, 'managed-runtime', '--',
      'serve-coding-session-mcp', '--config', '/private/config'])
  for (const altered of [{ ...runtime, execArgv: ['--import', '/untrusted/loader'] },
    { ...runtime, entry: '/untrusted/entry.js' }]) {
    assert.throws(() => executorChildCommand(altered, ['serve'], 'linux'), /fixed release/u)
  }
})

test('development and other platforms preserve their local-only loader/entry command', () => {
  const development = { execPath: '/node', execArgv: ['--import', 'tsx'], entry: '/source/index.ts', packaged: false }
  assert.deepEqual(executorChildCommand(development, ['serve'], 'linux'),
    ['/node', '--import', 'tsx', '/source/index.ts', 'serve'])
  assert.deepEqual(executorChildCommand(runtime, ['serve'], 'win32'),
    [runtime.execPath, runtime.entry, 'serve'])
})

test('macOS and Windows compiled children cannot bypass native managed creation', () => {
  for (const [platform, directory, node, helper] of [
    ['darwin', `/Library/Application Support/Nessie Executor/releases/${'b'.repeat(64)}`,
      'nessie-executor-runtime', 'nessie-executor-native'],
    ['win32', 'C:\\Program Files\\Nessie Executor', 'nessie-executor-runtime.exe', 'nessie-executor-native.exe'],
  ] as const) {
    const separator = platform === 'win32' ? '\\' : '/'
    const packaged = { execPath: `${directory}${separator}${node}`, execArgv: [],
      entry: `${directory}${separator}nessie-executor.cjs`, packaged: true }
    assert.deepEqual(executorChildCommand(packaged, ['personal-chatgpt-credential'], platform),
      [`${directory}${separator}${helper}`, 'managed-runtime', '--', 'personal-chatgpt-credential'])
    assert.throws(() => executorChildCommand({ ...packaged, execArgv: ['--import', 'unknown'] }, [], platform))
  }
})
