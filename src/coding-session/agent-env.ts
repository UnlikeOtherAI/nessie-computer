import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import type { CodingSessionsConfig } from './config.js'
import { resolveProgramPath } from './program-path.js'

/**
 * The environment a coding agent runs in.
 *
 * The MCP SDK starts the bridge with a minimal, sudo-style environment (six
 * variables on POSIX, twelve on Windows), and the host inherits exactly that.
 * An agent needs the person's real session — their PATH, SSH agent socket,
 * locale, proxy and CA settings — so with `inheritUserSession` the host
 * rebuilds a login-like environment the way each OS builds one:
 *
 * - Windows: the string values of the machine then user `Environment`
 *   registry keys (user wins, `Path` is machine;user), each key's plain values
 *   set before its expandable ones are expanded, those against each other
 *   until nothing changes, so the order a key lists them in makes no
 *   difference, plus `PATHEXT`, `ComSpec`,
 *   `windir`, `ProgramData` and `TMP` where those are still missing.
 * - macOS: `launchctl getenv` for `SSH_AUTH_SOCK` and `TMPDIR`, then the login
 *   shell's `env -0`.
 * - Linux: `systemctl --user show-environment` (with `XDG_RUNTIME_DIR` and the
 *   user bus derived from `/run/user/<uid>`), then the login shell's `env -0`.
 *
 * Only the variables that couple an agent to a parent Claude Code session are
 * stripped — an owner's deliberate `CLAUDE_CODE_*` setting survives — plus the
 * executor's own markers (packaged CLI, reviewed digest, supervisor, systemd
 * unit), which describe the executor rather than the person. Then `pass` and
 * `set` apply, and auto-memory is off unless `set` turns it back on, so it
 * cannot become a channel between owners.
 */

export const PARENT_SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
] as const

const EXECUTOR_MARKERS = [
  'NESSIE_EXECUTOR_PACKAGED_CLI',
  'NESSIE_CODING_SESSIONS_CONFIG_DIGEST',
  'NESSIE_EXECUTOR_SUPERVISOR',
  'NESSIE_CODING_SESSION_UNIT',
]

const LOGIN_SHELL_MARKER = '__NESSIE_LOGIN_ENVIRONMENT__'

export type CommandOutcome = { code: number | null; missing: boolean; stdout: string }

export type CommandRunner = (
  file: string, args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; maxBytes?: number },
) => Promise<CommandOutcome>

const runResolved: CommandRunner = (file, args, options = {}) => new Promise((settle) => {
  execFile(file, args, {
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeout: options.timeoutMs ?? 15_000,
    windowsHide: true,
    maxBuffer: options.maxBytes ?? 4 * 1024 * 1024,
  }, (error, stdout) => {
    const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null
    settle({
      code: failure ? typeof failure.code === 'number' ? failure.code : null : 0,
      missing: failure?.code === 'ENOENT',
      stdout: String(stdout ?? ''),
    })
  })
})

/**
 * A command that outlives `timeoutMs` or prints more than `maxBytes` is killed
 * and answers with code `null`. A bare program name is found on the absolute
 * entries of its environment's `PATH` only, never in `cwd` — which is a
 * session's repository (`program-path.ts`) — and one found nowhere is missing.
 */
export const runCommand: CommandRunner = async (file, args, options = {}) => {
  const program = await resolveProgramPath(file, options.env ?? process.env)
  if (program === undefined) return { code: null, missing: true, stdout: '' }
  return runResolved(program, args, options)
}

/** An environment whose names compare the way the OS compares them. */
const environmentMap = (platform: NodeJS.Platform, from: NodeJS.ProcessEnv = {}) => {
  const values = new Map<string, { name: string; value: string }>()
  const key = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name)
  const map = {
    get: (name: string): string | undefined => values.get(key(name))?.value,
    set: (name: string, value: string): void => {
      const existing = values.get(key(name))
      values.set(key(name), { name: existing?.name ?? name, value })
    },
    delete: (name: string): void => { values.delete(key(name)) },
    toObject: (): Record<string, string> => Object.fromEntries(
      [...values.values()].map((entry) => [entry.name, entry.value]),
    ),
  }
  for (const [name, value] of Object.entries(from)) if (value !== undefined) map.set(name, value)
  return map
}

export type RegistryValue = { name: string; type: string; value: string }

/**
 * Both `Environment` keys, read through PowerShell as UTF-8 JSON. `reg query`
 * writes in the console's OEM code page when its output is redirected (CP852
 * on a Czech system), which garbled every non-ASCII value — a profile like
 * `C:\Users\Ondřej`, and with it the agent's PATH and TEMP. Values come back
 * unexpanded, with their kinds, so `%USERPROFILE%` is expanded here the same
 * way for both keys.
 */
const REGISTRY_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$out = [ordered]@{}',
  "foreach ($pair in @(@('machine', 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),"
  + " @('user', 'HKCU:\\Environment'))) {",
  '  $key = Get-Item -LiteralPath $pair[1] -ErrorAction SilentlyContinue; $values = @()',
  '  if ($key) { foreach ($name in $key.GetValueNames()) {',
  "    $values += ,@($name, [string]$key.GetValueKind($name), [string]$key.GetValue($name, '', 'DoNotExpandEnvironmentNames'))",
  '  } }',
  '  $out[$pair[0]] = $values',
  '}',
  'ConvertTo-Json -InputObject $out -Compress -Depth 4',
].join('\n')

const REGISTRY_KINDS: Record<string, string> = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', MultiString: 'REG_MULTI_SZ' }

/** The script's `{machine: [[name, kind, value], …], user: […]}`, with kinds named as `reg` names them. */
export const parseRegistryJson = (text: string): { machine: RegistryValue[]; user: RegistryValue[] } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { machine: [], user: [] }
  }
  const values = (entries: unknown): RegistryValue[] => (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0]) return []
    const kind = typeof entry[1] === 'string' ? entry[1] : ''
    return [{ name: entry[0], type: REGISTRY_KINDS[kind] ?? kind, value: typeof entry[2] === 'string' ? entry[2] : '' }]
  })
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  return { machine: values(record.machine), user: values(record.user) }
}

/** `env -0` after our marker: NUL-separated `NAME=value`, immune to a noisy shell profile. */
export const parseLoginEnvironment = (text: string): Record<string, string> => {
  const start = text.indexOf(`${LOGIN_SHELL_MARKER}\0`)
  if (start < 0) return {}
  const entries: Record<string, string> = {}
  for (const entry of text.slice(start + LOGIN_SHELL_MARKER.length + 1).split('\0')) {
    const separator = entry.indexOf('=')
    if (separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.slice(0, separator))) {
      entries[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
  }
  return entries
}

/** `systemctl --user show-environment` prints `NAME=value`, C-quoting values as `$'…'` when needed. */
export const parseSystemdEnvironment = (text: string): Record<string, string> => {
  const entries: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator)
    let value = line.slice(separator + 1)
    if (value.startsWith("$'") && value.endsWith("'")) {
      value = value.slice(2, -1).replace(/\\(n|t|\\|')/gu, (_match, escape: string) => (
        escape === 'n' ? '\n' : escape === 't' ? '\t' : escape
      ))
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) entries[name] = value
  }
  return entries
}

const expandWindows = (value: string, lookup: (name: string) => string | undefined): string => (
  value.replace(/%([^%]+)%/gu, (match, name: string) => lookup(name) ?? match)
)

/** The most characters Windows lets one environment variable hold. */
const MAX_WINDOWS_VALUE = 32_767

const captureWindows = async (received: NodeJS.ProcessEnv, run: CommandRunner): Promise<Record<string, string>> => {
  const env = environmentMap('win32', received)
  const systemRoot = env.get('SystemRoot') ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { machine, user } = parseRegistryJson((await run(powershell, [
    '-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT,
  ])).stdout)
  const valueOf = (entry: RegistryValue): string => (entry.type === 'REG_EXPAND_SZ' ? expandWindows(entry.value, env.get) : entry.value)
  const isPath = (entry: RegistryValue): boolean => entry.name.toUpperCase() === 'PATH'
  const paths: string[] = []
  for (const [scope, entries] of [['machine', machine], ['user', user]] as const) {
    // String values only, as a logon takes them. The machine key's USERNAME is SYSTEM; the logon's is the right one.
    const kept = entries.filter((entry) => (entry.type === 'REG_SZ' || entry.type === 'REG_EXPAND_SZ')
      && !(scope === 'machine' && entry.name.toUpperCase() === 'USERNAME'))
    for (const entry of kept) if (entry.type === 'REG_SZ' && !isPath(entry)) env.set(entry.name, entry.value)
    // The expandable ones after the plain ones, all of them in rounds against what the last round set, until a
    // round changes nothing: `GOBIN=%GOPATH%\bin` resolves wherever the key lists the two, since the order a key
    // lists its values in is when each was written, not what each needs. A value naming itself reads what came
    // before this key. A cycle ends within one round per value, none longer than Windows lets a variable be.
    const expandable = kept.filter((entry) => entry.type === 'REG_EXPAND_SZ' && !isPath(entry))
    const before = new Map(expandable.map((entry) => [entry.name.toUpperCase(), env.get(entry.name)]))
    for (let round = 0; round <= expandable.length; round += 1) {
      const next = expandable.map((entry) => [entry.name, expandWindows(entry.value, (name) => (
        name.toUpperCase() === entry.name.toUpperCase() ? before.get(name.toUpperCase()) : env.get(name)
      )).slice(0, MAX_WINDOWS_VALUE)] as const)
      if (next.every(([name, value]) => env.get(name) === value)) break
      for (const [name, value] of next) env.set(name, value)
    }
    const path = kept.find(isPath)
    if (path) paths.push(valueOf(path))
  }
  if (paths.some(Boolean)) env.set('Path', paths.filter(Boolean).join(';'))
  if (!env.get('PATHEXT')) env.set('PATHEXT', '.COM;.EXE;.BAT;.CMD')
  if (!env.get('ComSpec')) env.set('ComSpec', join(systemRoot, 'System32', 'cmd.exe'))
  if (!env.get('windir')) env.set('windir', systemRoot)
  if (!env.get('ProgramData')) env.set('ProgramData', env.get('ALLUSERSPROFILE') ?? `${env.get('SystemDrive') ?? 'C:'}\\ProgramData`)
  if (!env.get('TMP') && env.get('TEMP')) env.set('TMP', env.get('TEMP')!)
  return env.toObject()
}

const loginShell = async (env: Record<string, string>, run: CommandRunner): Promise<Record<string, string>> => {
  const shell = env.SHELL?.startsWith('/') ? env.SHELL : '/bin/sh'
  const outcome = await run(shell, ['-lc', `printf '%s\\0' ${LOGIN_SHELL_MARKER}; env -0`], { env, timeoutMs: 10_000 })
  return parseLoginEnvironment(outcome.stdout)
}

const capturePosix = async (
  platform: NodeJS.Platform, received: NodeJS.ProcessEnv, run: CommandRunner,
): Promise<Record<string, string>> => {
  let env: Record<string, string> = environmentMap(platform, received).toObject()
  if (platform === 'darwin') {
    for (const name of ['SSH_AUTH_SOCK', 'TMPDIR']) {
      const value = (await run('/bin/launchctl', ['getenv', name])).stdout.trim()
      if (value) env[name] = value
    }
  } else {
    const uid = process.getuid?.()
    const runtime = uid === undefined ? undefined : `/run/user/${uid}`
    if (runtime && await access(runtime).then(() => true, () => false)) {
      env.XDG_RUNTIME_DIR ??= runtime
      if (await access(`${runtime}/bus`).then(() => true, () => false)) env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${runtime}/bus`
    }
    const systemd = await run('systemctl', ['--user', 'show-environment'], { env, timeoutMs: 5_000 })
    if (systemd.code === 0) env = { ...env, ...parseSystemdEnvironment(systemd.stdout) }
  }
  return { ...env, ...await loginShell(env, run) }
}

export const captureUserSessionEnvironment = (
  platform: NodeJS.Platform, received: NodeJS.ProcessEnv, run: CommandRunner = runCommand,
): Promise<Record<string, string>> => (
  platform === 'win32' ? captureWindows(received, run) : capturePosix(platform, received, run)
)

export const buildAgentEnvironment = async (input: {
  config: CodingSessionsConfig['agentEnv']
  platform?: NodeJS.Platform
  received?: NodeJS.ProcessEnv
  run?: CommandRunner
}): Promise<Record<string, string>> => {
  const platform = input.platform ?? process.platform
  const received = input.received ?? process.env
  const base = input.config.inheritUserSession
    ? await captureUserSessionEnvironment(platform, received, input.run ?? runCommand)
    : received
  const env = environmentMap(platform, base)
  for (const name of [...PARENT_SESSION_VARIABLES, ...EXECUTOR_MARKERS]) env.delete(name)
  const receivedMap = environmentMap(platform, received)
  for (const name of input.config.pass) {
    const value = receivedMap.get(name)
    if (value !== undefined) env.set(name, value)
  }
  env.set('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1')
  for (const [name, value] of Object.entries(input.config.set)) env.set(name, value)
  return env.toObject()
}
