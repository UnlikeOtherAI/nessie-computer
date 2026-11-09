import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { claudeDeclaredLocalApps } from '../src/local-app-discovery-claude.js'
import { codexDeclaredLocalApps } from '../src/local-app-discovery-codex.js'
import { discoverLocalApps, localAppName } from '../src/local-app-discovery.js'

const windows = process.platform === 'win32'

/** A PATH folder with the named programs; on Windows Kelpie is npm's `.cmd` shim. */
const binFolder = async (...names: string[]) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-apps-')))
  const file = (name: string): string => join(dir, windows ? `${name}${name === 'kelpie' ? '.cmd' : '.exe'}` : name)
  for (const name of names) {
    await writeFile(file(name), '#!/bin/sh\nexit 0\n')
    await chmod(file(name), 0o755)
  }
  return { dir, file, done: () => rm(dir, { force: true, recursive: true }) }
}

test('Claude Code: user-scope stdio servers only, read exactly', () => {
  const text = JSON.stringify({
    mcpServers: {
      chatterbox: { type: 'stdio', command: 'chatterbox-mcp', args: ['--stdio'], env: { TOKEN: 'x' } },
      plain: { command: '/opt/tool', args: [] },
      linear: { type: 'http', url: 'https://mcp.linear.app' },
      sse: { type: 'sse', url: 'https://example.test' },
      broken: { command: 'x', args: ['ok', 3] },
      noCommand: { args: ['x'] },
      badEnv: { command: 'x', env: { A: 1 } },
    },
    projects: { '/repo': { mcpServers: { local: { command: 'repo-only' } } } },
  })
  assert.deepEqual(claudeDeclaredLocalApps(text), [
    { name: 'chatterbox', command: ['chatterbox-mcp', '--stdio'], env: { TOKEN: 'x' } },
    { name: 'plain', command: ['/opt/tool'] },
  ])
  assert.deepEqual(claudeDeclaredLocalApps('{not json'), [])
  assert.deepEqual(claudeDeclaredLocalApps('[]'), [])
})

test('Codex: stdio tables with inline or table env, remote and disabled ones left out', () => {
  const text = [
    'model = "gpt-5"',
    'instructions = """',
    'Multi-line text with [mcp_servers.fake] and "quotes" inside.',
    '"""',
    '',
    '[mcp_servers.node_repl]',
    'command = "node"',
    'args = [',
    '  "repl.js", # trailing comment',
    "  'literal\\path',",
    ']',
    'env_vars = ["HOME"]',
    'startup_timeout_sec = 20',
    '',
    '[mcp_servers.node_repl.env]',
    'NODE_PATH = "/opt/node"',
    '"QUOTED KEY" = "v\\u00e9"',
    '',
    '[mcp_servers.computer-use]',
    'command = "/Applications/Tool.app/Contents/MacOS/tool"',
    'args = ["mcp"]',
    'cwd = "/tmp"',
    'env = { A = "1", B = \'2\' }',
    'enabled = true',
    '',
    '[mcp_servers.docs]',
    'url = "https://developers.openai.com/mcp"',
    '',
    '[mcp_servers.off]',
    'command = "off"',
    'enabled = false',
    '',
    '[mcp_servers.fermentea.tools.search]',
    'approval_mode = "approve"',
    '',
    '[mcp_servers."1password"]',
    'command = "op-mcp"',
    '',
    '[mcp_servers.wrong]',
    'command = ["not", "a", "string"]',
    '',
    '[desktop]',
    'sansFontSize = 14',
    'when = 1979-05-27',
  ].join('\n')
  assert.deepEqual(codexDeclaredLocalApps(text), [
    { name: 'node_repl', command: ['node', 'repl.js', 'literal\\path'], env: { NODE_PATH: '/opt/node', 'QUOTED KEY': 'vé' } },
    { name: 'computer-use', command: ['/Applications/Tool.app/Contents/MacOS/tool', 'mcp'], cwd: '/tmp', env: { A: '1', B: '2' } },
    { name: '1password', command: ['op-mcp'] },
  ])
})

test('Codex: a file the reader cannot follow yields nothing rather than a guess', () => {
  assert.deepEqual(codexDeclaredLocalApps('[mcp_servers.a]\ncommand = "a"\nargs = ["unterminated\n'), [])
  assert.deepEqual(codexDeclaredLocalApps('[[profiles]]\nname = "x"\n[mcp_servers.a]\ncommand = "a"\n'), [])
  assert.deepEqual(codexDeclaredLocalApps('[mcp_servers.a]\ncommand = "a" "b"\n'), [])
})

test('names are fitted to the server grammar, or left out', () => {
  assert.equal(localAppName('node_repl'), 'node-repl')
  assert.equal(localAppName('openaiDeveloperDocs'), 'openaideveloperdocs')
  assert.equal(localAppName('  My Server!! '), 'my-server')
  assert.equal(localAppName('1password'), '1password')
  assert.equal(localAppName('___'), undefined)
  assert.equal(localAppName('ž'), undefined)
  assert.equal(localAppName('a'.repeat(39) + '-b'), 'a'.repeat(39))
})

test('discovery: Kelpie first, then Claude Code, then Codex; programs resolved to absolute paths', async () => {
  const bin = await binFolder('kelpie', 'chatterbox-mcp')
  try {
    const home = join(bin.dir, 'home')
    const files: Record<string, string> = {
      [join(home, '.claude.json')]: JSON.stringify({ mcpServers: {
        kelpie: { command: 'kelpie-other', args: ['mcp'] },
        chatterbox: { command: 'chatterbox-mcp' },
        missing: { command: 'not-installed-anywhere' },
        'coding-sessions': { command: 'chatterbox-mcp' },
      } }),
      [join(home, '.codex', 'config.toml')]: '[mcp_servers.chatterbox]\ncommand = "other"\n'
        + '[mcp_servers.node_repl]\ncommand = "chatterbox-mcp"\nargs = ["--repl"]\n',
    }
    const apps = await discoverLocalApps({
      env: { PATH: bin.dir }, home, readText: async (path) => files[path],
    })
    assert.deepEqual(apps.map(({ installed, server }) => [server.name, server.source, installed]), [
      ['kelpie', 'unlikeotherai', true],
      ['chatterbox', 'claude-code', true],
      ['missing', 'claude-code', false],
      ['node-repl', 'codex', true],
    ])
    assert.deepEqual(apps[0]!.server.command, [bin.file('kelpie'), 'mcp'])
    assert.deepEqual(apps[1]!.server.command, [bin.file('chatterbox-mcp')])
    assert.deepEqual(apps[2]!.server.command, ['not-installed-anywhere'], 'a program found nowhere keeps its name')
    assert.deepEqual(apps[3]!.server.command, [bin.file('chatterbox-mcp'), '--repl'])
  } finally { await bin.done() }
})

test('discovery honours CLAUDE_CONFIG_DIR and CODEX_HOME, and finds nothing on an empty computer', async () => {
  const bin = await binFolder('tool')
  try {
    const claudeDir = join(bin.dir, 'claude-config')
    const codexDir = join(bin.dir, 'codex-home')
    const read: string[] = []
    const apps = await discoverLocalApps({
      env: { PATH: bin.dir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }, home: join(bin.dir, 'home'),
      readText: async (path) => { read.push(path); return undefined },
    })
    assert.deepEqual(apps, [])
    assert.deepEqual(read, [join(claudeDir, '.claude.json'), join(codexDir, 'config.toml')])
    assert.deepEqual(await discoverLocalApps({ env: { PATH: '' }, home: bin.dir, readText: async () => undefined }), [])
  } finally { await bin.done() }
})

test('discovery refuses what the policy could not carry', async () => {
  const bin = await binFolder('tool')
  try {
    const home = join(bin.dir, 'home')
    const text = JSON.stringify({ mcpServers: {
      relative: { command: 'tool', cwd: 'relative/dir' },
      long: { command: 'tool', args: Array.from({ length: 20 }, (_, index) => String(index)) },
      ok: { command: 'tool' },
    } })
    const apps = await discoverLocalApps({
      env: { PATH: bin.dir }, home, readText: async (path) => (path === join(home, '.claude.json') ? text : undefined),
    })
    assert.deepEqual(apps.map(({ server }) => server.name), ['ok'])
  } finally { await bin.done() }
})
