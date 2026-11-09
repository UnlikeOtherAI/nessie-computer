import assert from 'node:assert/strict'
import test from 'node:test'

import { requestedMcpServers } from '../src/mcp-server-changes.js'
import type { ExecutorLocalMcpServer } from '../src/mcp-servers.js'

const stored: ExecutorLocalMcpServer[] = [
  { name: 'alpha', command: ['/opt/alpha', 'mcp'], env: { ALPHA_TOKEN: 'secret-a' } },
  { name: 'beta', command: ['/opt/beta'], cwd: '/srv/beta', env: { BETA_TOKEN: 'secret-b' } },
  { name: 'kelpie', command: ['/opt/kelpie', 'mcp'], source: 'unlikeotherai' },
]

test('a removal takes out only the named servers and keeps every other one exactly as stored', () => {
  assert.deepEqual(requestedMcpServers(stored, { mcpServerRemovals: ['alpha'] }), [stored[1], stored[2]])
  // A name already gone is already removed: a repeated Remove changes nothing.
  assert.deepEqual(requestedMcpServers(stored, { mcpServerRemovals: ['gone'] }), stored)
  assert.throws(() => requestedMcpServers(stored, { mcpServerRemovals: ['kelpie'] }), /switched off rather than removed/u)
  assert.throws(() => requestedMcpServers(stored, { mcpServerRemovals: ['Not A Name'] }), /named by its name/u)
})

test('absent servers keep the stored list, and both kinds of change at once are refused', () => {
  assert.equal(requestedMcpServers(stored, {}), undefined)
  assert.throws(() => requestedMcpServers(stored, { mcpServers: [], mcpServerRemovals: ['alpha'] }), /not both/u)
})

test('a resent server without its stored environment is refused; env: {} clears it on purpose', () => {
  // What a client that copied describe's list (which omits env) would send.
  const copied = stored.filter((server) => server.source === undefined)
    .map(({ name, command, cwd }) => ({ name, command, ...(cwd ? { cwd } : {}) }))
  assert.throws(() => requestedMcpServers(stored, { mcpServers: copied }), /alpha without its environment/u)
  const cleared = [{ ...copied[0]!, env: {} }, stored[1]!]
  assert.deepEqual(requestedMcpServers(stored, { mcpServers: cleared }), cleared)
  // A new name has no stored environment to lose.
  const added = [...stored, { name: 'gamma', command: ['/opt/gamma'] }]
  assert.deepEqual(requestedMcpServers(stored, { mcpServers: added }), added)
})
