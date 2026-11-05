import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseExecutorMcpServerArguments } from '../src/mcp-server-arguments.js'
import { assertExecutorLocalMcpServers } from '../src/mcp-servers.js'

/**
 * The door a person types a local MCP server through. Its job is only to read
 * the spelling — every rule about what is acceptable belongs to
 * `assertExecutorLocalMcpServers`, so a policy proposed over stdin cannot reach
 * a weaker set of rules than one typed on a terminal.
 */

const configure = (...extra: string[]): string[] =>
  ['--state-dir', '/tmp/state', '--operations', 'mcp.tools,mcp.call', ...extra]

test('reads several named servers, splitting argv on spaces', () => {
  const servers = parseExecutorMcpServerArguments(configure(
    '--mcp-server', 'kelpie=kelpie mcp',
    '--mcp-server', 'other=/opt/other --flag value',
  ))
  assert.deepEqual(servers, [
    { command: ['kelpie', 'mcp'], name: 'kelpie' },
    { command: ['/opt/other', '--flag', 'value'], name: 'other' },
  ])
})

test('absent and cleared are different instructions', () => {
  // Absent keeps whatever the policy already names; `[]` is the instruction to
  // remove them all. A parser that returned `[]` for both would silently strip
  // a person's servers every time they changed an unrelated flag.
  assert.equal(parseExecutorMcpServerArguments(configure()), undefined)
  assert.deepEqual(parseExecutorMcpServerArguments(configure('--clear-mcp-servers')), [])
})

test('naming and clearing at once is refused rather than guessed', () => {
  assert.throws(
    () => parseExecutorMcpServerArguments(configure('--mcp-server', 'a=b', '--clear-mcp-servers')),
    /Name MCP servers with --mcp-server, or remove them all/,
  )
})

test('a value that is not <name>=<argv> is refused', () => {
  assert.throws(
    () => parseExecutorMcpServerArguments(configure('--mcp-server', 'kelpie mcp')),
    /needs <name>=<command and arguments>/,
  )
  assert.throws(
    () => parseExecutorMcpServerArguments(configure('--mcp-server', '=kelpie mcp')),
    /needs <name>=<command and arguments>/,
  )
})

test('a named server with no command to start is refused', () => {
  assert.throws(
    () => parseExecutorMcpServerArguments(configure('--mcp-server', 'kelpie=')),
    /needs a command to start/,
  )
  assert.throws(
    () => parseExecutorMcpServerArguments(configure('--mcp-server', 'kelpie=   ')),
    /needs a command to start/,
  )
})

test('a flag swallowing the next flag is refused rather than read as a value', () => {
  assert.throws(
    () => parseExecutorMcpServerArguments(['--mcp-server', '--state-dir', '/tmp/state']),
    /needs <name>=<command and arguments>/,
  )
})

test('the parser decides spelling; the policy decides acceptability', () => {
  // An illegal *name* parses here and is refused where every other writer of
  // the policy is also refused, so the two doors cannot drift apart.
  const parsed = parseExecutorMcpServerArguments(configure('--mcp-server', 'NotLegal=kelpie mcp'))
  assert.deepEqual(parsed, [{ command: ['kelpie', 'mcp'], name: 'NotLegal' }])
  assert.throws(
    () => assertExecutorLocalMcpServers(parsed!),
    /lowercase letters, digits and interior hyphens/,
  )
})
