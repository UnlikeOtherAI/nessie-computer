import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'

/**
 * On Linux a session host runs in its own transient systemd user unit when a
 * user manager is reachable:
 *
 *   systemd-run --user --collect --unit nessie-coding-<sessionId>-<start>
 *     -p KillMode=control-group -p TimeoutStopSec=10 -- <host argv>
 *
 * `setsid` alone does not leave a cgroup. The executor's own `service`
 * supervisor is a user unit with `KillMode=control-group`, so a host that
 * stayed in its cgroup would be killed by every stop, upgrade and crash of the
 * executor — and one tool process that ignores SIGTERM there would keep the
 * executor unit from ever restarting. In a unit of its own the host outlives
 * the executor, can never block its stop, and takes its whole cgroup with it
 * when it exits: an agent, and anything the agent left behind, cannot outlive
 * the host that answers for it. On close the host stops its unit explicitly.
 *
 * The MCP SDK hands the bridge a minimal environment without
 * `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`, which is how `systemctl
 * --user` finds the manager, so both are derived from `/run/user/<uid>`. With
 * no reachable manager — a container, WSL without systemd, a machine where
 * nobody enabled lingering — the host falls back to `setsid`, and a daemon
 * restart can then take it down, which the protocol chapter documents; with
 * no cgroup of its own to end the agent, that host starts it through the
 * agent guard (`agent-guard.ts`).
 */

/** Tells a host it runs in a unit, and which, so it can stop that unit on close. */
export const CODING_SESSION_UNIT_ENV = 'NESSIE_CODING_SESSION_UNIT'

/** Short, so a slow D-Bus cannot push a bridge call past its five seconds. */
const UNIT_TOOL_TIMEOUT_MS = 2_000

export type UserManager = { environment: NodeJS.ProcessEnv }

/** How the tool ended, with what it printed; `timeout` when it was stopped before it answered. */
export type UnitAnswer = { status: 'ok' | 'failed' | 'timeout'; stdout: string }

export type UnitRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<UnitAnswer>

const runUnitTool: UnitRunner = (file, args, env) => new Promise((settle) => {
  execFile(file, args, { env, timeout: UNIT_TOOL_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
    const status = !error ? 'ok' : (error as { killed?: boolean }).killed ? 'timeout' : 'failed'
    settle({ status, stdout: String(stdout ?? '') })
  })
})

/**
 * A unit of its own for every host start, not one per session: systemd keeps
 * a finished unit's name until it has collected it, and a start that reused
 * the name a moment after the last host exited was refused and fell back to a
 * detached host, outside any unit. `nessie-coding-<sessionId>-*` lists them.
 */
export const codingSessionUnitName = (sessionId: string): string => (
  `nessie-coding-${sessionId}-${randomBytes(4).toString('hex')}`
)

const UNIT_NAME = /^nessie-coding-[0-9a-f-]{36}-[0-9a-f]{8}$/u

const readOwnCgroup = (): string => readFileSync('/proc/self/cgroup', 'utf8')

/**
 * Whether this host runs in its own session unit: the environment names one
 * and the kernel agrees that this process is in its cgroup. Only then does
 * the unit end the agent when the host dies.
 */
export const runsInOwnUserUnit = (
  environment: NodeJS.ProcessEnv = process.env, cgroup: () => string = readOwnCgroup,
): boolean => {
  const unit = environment[CODING_SESSION_UNIT_ENV]
  if (!unit || !UNIT_NAME.test(unit)) return false
  try {
    return cgroup().includes(`/${unit}.service`)
  } catch {
    return false
  }
}

/**
 * The user manager this process can reach, with the two variables `systemctl
 * --user` needs filled in from `/run/user/<uid>` when they are missing.
 */
export const reachableUserManager = (input: {
  environment?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
  uid?: number
} = {}): UserManager | undefined => {
  const platform = input.platform ?? process.platform
  const uid = input.uid ?? process.getuid?.()
  if (platform !== 'linux' || uid === undefined) return undefined
  const environment = input.environment ?? process.env
  const exists = input.exists ?? existsSync
  const runtimeDir = environment.XDG_RUNTIME_DIR || `/run/user/${uid}`
  const bus = posix.join(runtimeDir, 'bus')
  if (!exists(posix.join(runtimeDir, 'systemd', 'private')) && !exists(bus)) return undefined
  return {
    environment: {
      ...environment,
      XDG_RUNTIME_DIR: runtimeDir,
      ...(!environment.DBUS_SESSION_BUS_ADDRESS && exists(bus) ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` } : {}),
    },
  }
}

/**
 * `systemd-run`'s argv for one host. The host's environment is passed with
 * `--setenv`, because a transient unit starts from the user manager's
 * environment rather than its caller's: the packaged-CLI marker and the
 * reviewed config digest would otherwise be lost on the way. Only the names
 * go on the command line — `--setenv=NAME` copies systemd-run's own value,
 * which is the environment it is started with — so no value is readable in
 * `/proc/<pid>/cmdline` by another local user while it runs.
 */
export const systemdRunArguments = (input: {
  argv: readonly string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  hostLog: string
  unit: string
}): string[] => [
  '--user', '--collect', '--quiet', '--unit', input.unit,
  '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=10',
  '-p', `WorkingDirectory=${input.cwd}`,
  '-p', `StandardOutput=append:${input.hostLog}`, '-p', `StandardError=append:${input.hostLog}`,
  ...Object.entries(input.environment).flatMap(([name, value]) => (
    value === undefined || name === CODING_SESSION_UNIT_ENV ? [] : [`--setenv=${name}`]
  )),
  `--setenv=${CODING_SESSION_UNIT_ENV}=${input.unit}`,
  '--', ...input.argv,
]

/**
 * Starts the host in its unit and answers with the unit's main process, which
 * is the host itself: the bridge records it, so a host still loading the
 * executor on a busy machine is waited for rather than joined by a second one
 * (`host-spawn.ts`). `undefined` means no unit was started — `systemd-run`
 * refused it, as an older systemd does — and the caller falls back to
 * `setsid`; the lock decides which host serves the session either way. Each
 * start names a unit of its own, so no earlier host's unit can be the reason
 * for a refusal. A `systemd-run` that timed out may have
 * started the unit anyway, so the unit is asked before a second host is
 * started beside it. A main process systemd does not name in time is
 * `undefined`, and the bridge then waits only its grace.
 */
export const startHostInUserUnit = async (input: {
  argv: readonly string[]
  hostLog: string
  sessionId: string
  manager: UserManager
  run?: UnitRunner
}): Promise<{ pid: number | undefined } | undefined> => {
  const run = input.run ?? runUnitTool
  const unit = codingSessionUnitName(input.sessionId)
  const started = await run('systemd-run', systemdRunArguments({
    argv: input.argv, cwd: process.cwd(), environment: input.manager.environment, hostLog: input.hostLog, unit,
  }), input.manager.environment)
  if (started.status === 'failed') return undefined
  const main = await run('systemctl', ['--user', 'show', '--property=MainPID', '--value', `${unit}.service`],
    input.manager.environment)
  // 0 when the unit has no running main process: never started, or already gone.
  const pid = main.status === 'ok' ? Number(main.stdout.trim()) : 0
  const known = Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  if (started.status === 'timeout' && known === undefined) return undefined
  return { pid: known }
}

/**
 * The host's last act when its session closes: stop its own unit, so systemd
 * kills whatever is left in the cgroup. `--no-block` because the host itself
 * is in that cgroup and is about to exit anyway.
 */
export const stopOwnUserUnit = async (
  environment: NodeJS.ProcessEnv = process.env, run: UnitRunner = runUnitTool,
): Promise<boolean> => {
  const unit = environment[CODING_SESSION_UNIT_ENV]
  if (!unit || !UNIT_NAME.test(unit)) return false
  const manager = reachableUserManager({ environment })
  if (!manager) return false
  return (await run('systemctl', ['--user', 'stop', '--no-block', `${unit}.service`], manager.environment)).status === 'ok'
}
