import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import {
  buildAgentEnvironment,
  captureUserSessionEnvironment,
  parseLoginEnvironment,
  parseRegistryJson,
  parseSystemdEnvironment,
  runCommand,
  type CommandRunner,
} from '../src/coding-session/agent-env.js'
import { resolveProgramPath } from '../src/coding-session/program-path.js'
import { runCodingSelfCheck } from '../src/coding-session/self-check.js'

/**
 * The agent's environment per OS, with each OS's source faked by the command
 * runner so all three arms run on any host. The subprocess suite covers the
 * real capture on the machine it runs on.
 */

/** What the registry script prints: both keys, each value's name, kind and unexpanded text. */
const REGISTRY = JSON.stringify({
  machine: [
    ['ComSpec', 'ExpandString', '%SystemRoot%\\system32\\cmd.exe'],
    ['Path', 'ExpandString', '%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd'],
    ['PATHEXT', 'String', '.COM;.EXE;.BAT;.CMD'],
    ['TEMP', 'ExpandString', '%SystemRoot%\\TEMP'],
    ['USERNAME', 'String', 'SYSTEM'],
    ['windir', 'ExpandString', '%SystemRoot%'],
    ['EMPTY', 'String', ''],
  ],
  user: [
    ['Path', 'ExpandString', '%USERPROFILE%\\AppData\\Roaming\\npm'],
    ['TEMP', 'ExpandString', '%USERPROFILE%\\AppData\\Local\\Temp'],
    ['TMP', 'ExpandString', '%USERPROFILE%\\AppData\\Local\\Temp'],
    ['GOPATH', 'ExpandString', '%USERPROFILE%\\go'],
    ['ONEDRIVE', 'String', 'C:\\Users\\Ondřej\\OneDrive'],
  ],
})

type Answer = { code?: number | null; missing?: boolean; stdout?: string }

const runner = (answers: Record<string, Answer>): CommandRunner => (
  async (file, args) => {
    const key = [file.replaceAll('\\', '/').split('/').pop(), ...args].join(' ')
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1]
    return { code: answer?.code === undefined ? 0 : answer.code, missing: answer?.missing ?? false, stdout: answer?.stdout ?? '' }
  }
)

test('registry values are read with their kinds, including empty ones, and anything else reads as none', () => {
  const { machine } = parseRegistryJson(REGISTRY)
  assert.deepEqual(machine.slice(0, 2), [
    { name: 'ComSpec', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\system32\\cmd.exe' },
    { name: 'Path', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd' },
  ])
  assert.deepEqual(machine.find((entry) => entry.name === 'EMPTY'), { name: 'EMPTY', type: 'REG_SZ', value: '' })
  assert.deepEqual(parseRegistryJson('not json'), { machine: [], user: [] })
})

test('Windows: machine then user, Path joined, the logon\'s USERNAME kept, names case-insensitive', async () => {
  const env = await captureUserSessionEnvironment('win32', {
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ondre', USERNAME: 'ondre', PATH: 'C:\\minimal', SystemDrive: 'C:',
  }, runner({ 'powershell.exe -NoProfile': { stdout: REGISTRY } }))
  assert.equal(env.ComSpec, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(env.PATH, 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\ondre\\AppData\\Roaming\\npm')
  assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === 'PATH').length, 1)
  assert.equal(env.USERNAME, 'ondre')
  assert.equal(env.TEMP, 'C:\\Users\\ondre\\AppData\\Local\\Temp')
  assert.equal(env.GOPATH, 'C:\\Users\\ondre\\go')
  assert.equal(env.windir, 'C:\\Windows')
  assert.equal(env.ProgramData, 'C:\\ProgramData')
  assert.equal(env.ONEDRIVE, 'C:\\Users\\Ondřej\\OneDrive', 'read as UTF-8, not the console code page')
})

const captureRegistry = (registry: Record<'machine' | 'user', string[][]>) => captureUserSessionEnvironment('win32', {
  SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ondre', USERNAME: 'ondre', PATH: 'C:\\minimal', SystemDrive: 'C:',
}, runner({ 'powershell.exe -NoProfile': { stdout: JSON.stringify(registry) } }))

test('Windows: only string values become variables, as a logon takes them', async () => {
  const env = await captureRegistry({
    machine: [['Path', 'ExpandString', '%SystemRoot%\\system32'], ['INSTALLER_FLAG', 'DWord', '1'], ['INSTALLER_SIZE', 'QWord', '4294967296']],
    user: [['INCLUDE_DIRS', 'MultiString', 'C:\\a C:\\b'], ['BLOB', 'Binary', '1 2 3'], ['NOTHING', 'None', ''], ['PLAIN', 'String', 'yes']],
  })
  assert.equal(env.PLAIN, 'yes')
  assert.equal(env.PATH, 'C:\\Windows\\system32')
  for (const name of ['INSTALLER_FLAG', 'INSTALLER_SIZE', 'INCLUDE_DIRS', 'BLOB', 'NOTHING']) assert.equal(env[name], undefined, name)
})

test('Windows: an expandable value reads the same whatever order its key lists its values in', async () => {
  const machine = [
    ['DEVKIT_BIN', 'ExpandString', '%DEVKIT%\\bin'],
    ['Path', 'ExpandString', '%SystemRoot%\\system32;%DEVKIT_BIN%'],
    ['DEVKIT', 'String', 'C:\\devkit'],
  ]
  // A user Path from profile creation lists before the variables installers added to it later.
  const user = [
    ['Path', 'ExpandString', '%PYENV_HOME%\\bin;%GOPATH%\\bin'],
    ['CACHE', 'ExpandString', '%GOPATH%\\cache'],
    ['GOPATH', 'ExpandString', '%USERPROFILE%\\go'],
    ['PYENV_HOME', 'String', 'C:\\Users\\ondre\\.pyenv'],
    ['TOOLS', 'ExpandString', '%DEVKIT_BIN%\\tools'],
  ]
  const listed = await captureRegistry({ machine, user })
  assert.equal(listed.DEVKIT_BIN, 'C:\\devkit\\bin', 'a plain value is set before any expandable one of its key')
  assert.equal(listed.TOOLS, 'C:\\devkit\\bin\\tools', 'the machine key is merged before the user key expands')
  assert.equal(listed.PATH, 'C:\\Windows\\system32;C:\\devkit\\bin;C:\\Users\\ondre\\.pyenv\\bin;C:\\Users\\ondre\\go\\bin',
    'each half of Path is expanded once its own key is merged')
  assert.equal(listed.CACHE, 'C:\\Users\\ondre\\go\\cache', 'an expandable value reads another of its own key, listed after it')
  assert.deepEqual(await captureRegistry({ machine: [...machine].reverse(), user: [...user].reverse() }), listed)
})

test('Windows: an expandable value naming itself reads what came before its key, and a cycle ends', async () => {
  const env = await captureRegistry({
    machine: [['PSModulePath', 'ExpandString', '%SystemRoot%\\modules']],
    user: [
      ['PSModulePath', 'ExpandString', '%PSModulePath%;%USERPROFILE%\\modules'],
      ['PING', 'ExpandString', '%PONG%%PONG%'], ['PONG', 'ExpandString', '%PING%%PING%'],
    ],
  })
  assert.equal(env.PSModulePath, 'C:\\Windows\\modules;C:\\Users\\ondre\\modules', 'once, not once per round')
  assert.ok(env.PING!.length <= 32_767 && env.PONG!.length <= 32_767, 'no longer than Windows lets a variable be')
})

test('macOS: launchctl supplies the agent socket, the login shell the rest, past a noisy profile', async () => {
  const login = `Last login: today\nwelcome!\n__NESSIE_LOGIN_ENVIRONMENT__\0LANG=en_GB.UTF-8\0PATH=/opt/homebrew/bin:/usr/bin\0BAD NAME=x\0MULTI=a\nb\0`
  const env = await captureUserSessionEnvironment('darwin', { HOME: '/Users/ondre', SHELL: '/bin/zsh', PATH: '/usr/bin' }, runner({
    'launchctl getenv SSH_AUTH_SOCK': { stdout: '/private/tmp/com.apple.launchd.x/Listeners\n' },
    'launchctl getenv TMPDIR': { stdout: '' },
    'zsh -lc': { stdout: login },
  }))
  assert.equal(env.SSH_AUTH_SOCK, '/private/tmp/com.apple.launchd.x/Listeners')
  assert.equal(env.LANG, 'en_GB.UTF-8')
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.equal(env.MULTI, 'a\nb')
  assert.equal(env['BAD NAME'], undefined)
  assert.equal(env.TMPDIR, undefined)
  assert.deepEqual(parseLoginEnvironment('no marker at all'), {})
})

test('Linux: the systemd user manager, then the login shell', async () => {
  assert.deepEqual(parseSystemdEnvironment("LANG=C.UTF-8\nQUOTED=$'a\\nb'\n=broken\n"), { LANG: 'C.UTF-8', QUOTED: 'a\nb' })
  const env = await captureUserSessionEnvironment('linux', { HOME: '/home/ondre', SHELL: '/bin/bash', PATH: '/usr/bin' }, runner({
    'systemctl --user show-environment': { stdout: 'SSH_AUTH_SOCK=/run/user/1000/keyring/ssh\nLANG=C.UTF-8\n' },
    'bash -lc': { stdout: '__NESSIE_LOGIN_ENVIRONMENT__\0LANG=en_US.UTF-8\0' },
  }))
  assert.equal(env.SSH_AUTH_SOCK, '/run/user/1000/keyring/ssh')
  assert.equal(env.LANG, 'en_US.UTF-8', 'the login shell has the last word')
})

test('only the parent-session coupling and the executor markers are stripped; pass and set apply after', async () => {
  const env = await buildAgentEnvironment({
    platform: 'linux',
    config: { inheritUserSession: false, pass: ['FORWARD_ME', 'ABSENT'], set: { EXTRA: '1' } },
    received: {
      PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/s',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_GIT_BASH_PATH: '/bash', NESSIE_EXECUTOR_PACKAGED_CLI: '1',
      NESSIE_CODING_SESSIONS_CONFIG_DIGEST: 'sha256:x', FORWARD_ME: 'yes',
      NESSIE_EXECUTOR_SUPERVISOR: 'desktop', NESSIE_CODING_SESSION_UNIT: 'nessie-coding-x',
    },
  })
  assert.deepEqual(env, {
    PATH: '/usr/bin', CLAUDE_CODE_GIT_BASH_PATH: '/bash', FORWARD_ME: 'yes', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', EXTRA: '1',
  })
  const overridden = await buildAgentEnvironment({
    platform: 'win32', config: { inheritUserSession: false, pass: [], set: { claude_code_disable_auto_memory: '0' } }, received: {},
  })
  assert.deepEqual(overridden, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, 'set may turn auto-memory back on')
})

const helpText = (name: string): string => readFileSync(new URL(`./fixtures/agent-help/${name}`, import.meta.url), 'utf8')

test('the self-check names each failure, reads only the login flag, and treats gh as optional', async () => {
  const claude = { command: ['/opt/claude'], args: [], allowedTools: [], disallowedTools: [] }
  type CheckInput = Parameters<typeof runCodingSelfCheck>[0]
  const help = { 'claude --help': { stdout: helpText('claude-2.1.280.txt') } }
  const check = (answers: Record<string, Answer>, extra: Partial<CheckInput> = {}) => runCodingSelfCheck({
    agent: 'claude', config: claude, cwd: '/w', env: {}, platform: 'linux', run: runner({ ...help, ...answers }), ...extra,
  })
  const loggedIn = { stdout: '{"loggedIn":true,"email":"person@example.com"}' }
  assert.deepEqual(await check({ 'git --version': {}, 'gh auth': { missing: true }, 'claude --version': { stdout: '2.1.280 (Claude Code)\n' }, 'claude auth': loggedIn }), {
    ok: true, agentVersion: '2.1.280 (Claude Code)',
  })
  assert.deepEqual(await check({ 'git --version': { code: null, missing: true } }), { ok: false, reason: 'git_missing' })
  assert.deepEqual(await check({ 'gh auth': { missing: true }, 'claude --version': { code: null, missing: true } }), {
    ok: false, reason: 'agent_missing',
  })
  assert.deepEqual(await check({ 'gh auth': { missing: true }, 'claude auth': { code: 1, stdout: '{"loggedIn":false}' } }), {
    ok: false, reason: 'agent_not_logged_in',
  })
  // What the CLI offers is read before its login: a CLI too old for `auth status` is outdated, not logged out.
  assert.deepEqual(await check({ 'claude --help': { stdout: helpText('claude-older.txt') }, 'claude auth': { code: 1 } }), {
    ok: false, reason: 'agent_outdated', missing: ['--permission-prompts'],
  })
  // A help that did not answer proves nothing about the CLI's age.
  assert.deepEqual(await check({ 'claude --help': { code: null } }), { ok: false, reason: 'agent_help_unreadable', missing: ['--help'] })
  assert.deepEqual(await check({ 'gh auth': { missing: true }, 'claude auth': loggedIn }, {
    config: { ...claude, permissionMode: 'default' },
  }), { ok: false, reason: 'permission_mode_unsupported', missing: ['--permission-mode default'] })
  // Choices this parser cannot read refuse nothing; the host logs the mode as not checked.
  const unquoted = helpText('claude-2.1.280.txt').replace(/\(choices: "acceptEdits",[\s\S]*?"plan"\)/u, '(choices: acceptEdits, plan)')
  assert.deepEqual(await check({
    'claude --help': { stdout: unquoted }, 'gh auth': { missing: true }, 'claude --version': { stdout: '2.1.280 (Claude Code)\n' }, 'claude auth': loggedIn,
  }, { config: { ...claude, permissionMode: 'plan' } }), { ok: true, agentVersion: '2.1.280 (Claude Code)', unverified: ['--permission-mode plan'] })
  assert.deepEqual(await check({ 'gh auth': { code: 1 }, 'claude auth': loggedIn }), { ok: false, reason: 'gh_not_authenticated' })
  assert.deepEqual(await check({}, { platform: 'win32', received: { NESSIE_EXECUTOR_SUPERVISOR: 'service' } }), {
    ok: false, reason: 'unsupported_supervisor',
  })
  const codex = await runCodingSelfCheck({
    agent: 'codex', config: { command: ['node', 'codex.js'], args: [], allowedTools: [], disallowedTools: [] }, cwd: '/w', env: {},
    platform: 'linux', run: runner({
      'gh auth': { missing: true },
      'node codex.js exec resume --help': { stdout: helpText('codex-0.155.1-exec-resume.txt') },
      'node codex.js exec --help': { stdout: helpText('codex-0.155.1-exec.txt') },
      'node codex.js login status': { code: 1 },
    }),
  })
  assert.deepEqual(codex, { ok: false, reason: 'agent_not_logged_in' })
})

const windows = process.platform === 'win32'
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

/**
 * A program planted in a session's folder, the way each OS would find it
 * there by a bare name: a copy of `whoami.exe` on Windows, where libuv tries
 * the child's working directory before PATH (unless this process carries
 * `NoDefaultCurrentDirectoryInExePath`), and a shell script behind a relative
 * PATH entry elsewhere, which `execvp` honours.
 */
const plantProgram = async (directory: string, name: string): Promise<string> => {
  const path = join(directory, windows ? `${name}.exe` : name)
  if (windows) await copyFile(join(system32, 'whoami.exe'), path)
  else await writeFile(path, '#!/bin/sh\necho planted\n', { mode: 0o755 })
  return path
}

type RawOptions = { cwd: string; env: NodeJS.ProcessEnv }

const rawExitCode = (file: string, args: string[], options: RawOptions): Promise<unknown> => new Promise((settle) => {
  execFile(file, args, options, (error) => settle(error ? error.code : 0))
})

test('a bare program name is found on the absolute PATH entries only, never in the session folder', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-program-path-')))
  // What makes Windows skip the working directory is read from this process's own environment.
  const skipCwd = process.env.NoDefaultCurrentDirectoryInExePath
  delete process.env.NoDefaultCurrentDirectoryInExePath
  try {
    const repo = join(dir, 'repo')
    const bin = join(dir, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    const planted = await plantProgram(repo, 'nessie-probe')
    const args = windows ? ['/?'] : []
    // Windows searches the folder on its own; POSIX through the relative entry.
    const env = windows ? { PATH: system32, SystemRoot: process.env.SystemRoot } : { PATH: `.:/usr/bin:/bin` }
    assert.equal(await rawExitCode('nessie-probe', args, { cwd: repo, env }), 0, 'left to the OS, the planted program runs')
    assert.equal(await resolveProgramPath('nessie-probe', env), undefined)
    assert.deepEqual(await runCommand('nessie-probe', args, { cwd: repo, env }), { code: null, missing: true, stdout: '' },
      'nothing in the session folder runs')
    // A relative entry naming the folder, and a directory in the name, are relative to it too.
    assert.equal(await resolveProgramPath('nessie-probe', { PATH: ['repo', ''].join(delimiter) }), undefined)
    assert.equal(await resolveProgramPath(join('repo', 'nessie-probe'), env), undefined)
    assert.equal(await resolveProgramPath(planted, {}), planted, 'an absolute path is taken as it is')
    // An absolute entry that holds the program is where it is found, however PATH is spelled.
    const installed = await plantProgram(bin, 'nessie-probe')
    const found = windows ? { Path: `repo;${bin}`, SystemRoot: process.env.SystemRoot } : { PATH: `repo:${bin}` }
    assert.equal(await resolveProgramPath('nessie-probe', found), installed)
    assert.equal((await runCommand('nessie-probe', args, { cwd: repo, env: found })).code, 0)
  } finally {
    if (skipCwd !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = skipCwd
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
