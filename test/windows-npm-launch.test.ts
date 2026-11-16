import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { runCommand } from '../src/coding-session/agent-env.js'
import { resolveProgramLaunch } from '../src/coding-session/program-launch.js'
import { alive, createCodingHarness, waitUntil } from './coding-session-harness.js'

const windows = process.platform === 'win32'
const prefix = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n'
const nodeForward = '\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n'
  + '  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\n'
  + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '
const shim = (entry: string, node = true) => prefix + (node ? nodeForward : '') + '"%dp0%\\' + entry + '"   %*\n'
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie npm & launch '))
  const entry = join(dir, 'node_modules', 'fixture', 'cli.cjs')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(join(dir, 'claude.cmd'), shim('node_modules\\fixture\\cli.cjs').replaceAll('\n', '\r\n'))
  // A normal npm installation also has an extensionless POSIX forwarder.
  await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 99\n')
  const env = { PATH: dir + ';' + dirname(process.execPath), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot }
  return { dir, entry, env, clean: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) }
}

test('npm native and Node forwarders resolve to literal launches and probes ignore cwd impostors', { skip: !windows }, async () => {
  const f = await fixture()
  try {
    await writeFile(f.entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const cwd = join(f.dir, 'hostile repo')
    await mkdir(cwd)
    await copyFile(process.execPath, join(cwd, 'claude.exe'))
    await writeFile(join(cwd, 'node.exe'), 'not a runtime')
    const args = ['space here', 'a&b|c', '%PATH%', '!value!', 'quote"tail', 'trailing\\']
    const command = await resolveProgramLaunch(['claude', ...args], f.env)
    assert.deepEqual(command, [process.execPath, f.entry, ...args])
    const result = await runCommand('claude', args, { cwd, env: f.env })
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), args)
    const native = join(dirname(f.entry), 'claude.exe')
    await copyFile(process.execPath, native)
    await writeFile(join(f.dir, 'claude.cmd'), shim('node_modules\\fixture\\claude.exe', false))
    assert.deepEqual(await resolveProgramLaunch(['claude', '--version'], f.env), [native, '--version'])
    for (const malformed of [shim('node_modules\\fixture\\cli.cjs') + 'echo extra\n',
      shim('node_modules\\..\\outside.js'), shim('node_modules\\fixture\\%INJECT%.js'), '@echo off\nnode evil.js %*\n']) {
      await writeFile(join(f.dir, 'claude.cmd'), malformed)
      assert.equal(await resolveProgramLaunch(['claude'], f.env), undefined)
    }
  } finally { await f.clean() }
})

test('a one-line forwarder to a full path resolves to that program, and any other script is refused', {
  skip: !windows,
}, async () => {
  const f = await fixture()
  try {
    const target = join(f.dir, 'tools dir', 'codex-x86_64-pc-windows-msvc.exe')
    await mkdir(dirname(target))
    await copyFile(process.execPath, target)
    await writeFile(join(f.dir, 'codex.cmd'), `@"${target}" %*\r\n`)
    assert.deepEqual(await resolveProgramLaunch(['codex', '--version', 'a&b', '%PATH%'], f.env),
      [target, '--version', 'a&b', '%PATH%'])
    await writeFile(join(f.dir, 'codex.cmd'), `"${target}" %*`)
    assert.deepEqual(await resolveProgramLaunch(['codex'], f.env), [target])
    const script = join(f.dir, 'tools dir', 'run.bat')
    await writeFile(script, '@echo off\r\n')
    for (const refused of [`@"${target}" %*\r\necho extra\r\n`, `@"${target}" --flag %*\r\n`,
      `@"%LOCALAPPDATA%\\codex.exe" %*\r\n`, `@"${f.dir}\\tools dir\\..\\tools dir\\codex.exe" %*\r\n`,
      '@"tools dir\\codex-x86_64-pc-windows-msvc.exe" %*\r\n', `@"${join(f.dir, 'missing.exe')}" %*\r\n`,
      `@"${script}" %*\r\n`, `@call "${target}" %*\r\n`]) {
      await writeFile(join(f.dir, 'codex.cmd'), refused)
      assert.equal(await resolveProgramLaunch(['codex'], f.env), undefined, refused)
    }
  } finally { await f.clean() }
})

test('an npm-installed terminal reaches first output, follow-up and contained descendant teardown', {
  skip: !windows, timeout: 120_000,
}, async () => {
  const f = await fixture()
  const descendant = join(f.dir, 'descendant.json')
  await writeFile(f.entry, [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const { createInterface } = require('node:readline')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'})",
    "writeFileSync(process.env.NESSIE_NPM_CHILD, JSON.stringify({pid:child.pid}))",
    "console.log('NPM_READY:' + JSON.stringify(process.argv.slice(2)))",
    "let marker = ''; createInterface({ input: process.stdin }).on('line', line => {",
    "if (!marker) {marker = line; console.log('FIRST:' + marker + ':391')}",
    "else console.log('FOLLOW:' + marker + ':400:' + line)",
    "})",
  ].join('\n'))
  const harness = await createCodingHarness({ agentEnv: { inheritUserSession: false,
    set: { ...f.env, NESSIE_NPM_CHILD: descendant } } })
  try {
    await copyFile(process.execPath, join(harness.root, 'claude.exe'))
    const argument = 'literal & | %PATH% ! " tail\\'
    const start = await harness.call('session_start', {
      agent: 'terminal', command: ['claude', argument], cwd: harness.root,
    })
    assert.equal(start.ok, true, JSON.stringify(start.body))
    const sessionId = String(start.body.sessionId)
    const screen = (marker: string) => waitUntil(async () => {
      const reply = await harness.call('terminal_read', { sessionId })
      return typeof reply.body.text === 'string' && reply.body.text.includes(marker) ? reply.body.text : undefined
    }, 40_000, marker)
    assert.match(await screen('NPM_READY:'), /literal & \| %PATH% !/u)
    const child = JSON.parse(await readFile(descendant, 'utf8')) as { pid: number }
    assert.equal(alive(child.pid), true)
    const send = async (message: string) => assert.equal((await harness.call('session_send', {
      sessionId, message: message + '\r', terminal: true,
    })).ok, true)
    await send('NPM_SESSION_MARKER')
    await screen('FIRST:NPM_SESSION_MARKER:391')
    await send('next & | %PATH%')
    await screen('FOLLOW:NPM_SESSION_MARKER:400:next & | %PATH%')
    assert.equal((await harness.call('session_close', { sessionId })).ok, true)
    await harness.waitForStatus(sessionId, (state) => state.status === 'closed')
    await waitUntil(async () => !alive(child.pid) ? true : undefined, 15_000, 'contained descendant stopped')
  } finally { await harness.cleanup(); await f.clean() }
})
