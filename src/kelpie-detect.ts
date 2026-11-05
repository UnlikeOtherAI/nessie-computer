import type { ChildProcess } from 'node:child_process'

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import spawn from 'cross-spawn'
import {
  EXECUTOR_KELPIE_DEVICE_MAXIMUM,
  KelpieDeviceSchema,
  type KelpieDevice,
} from '@nessie/executor-protocol'

import { createCodingProcessControl } from './coding-session/process-control.js'
import type { CodingProcessIdentity } from './coding-session/types.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'

/**
 * What Kelpie can be asked about itself, beyond "does its MCP server start".
 *
 * Kelpie announces itself over mDNS and **every instance picks its own port**,
 * so there is no address to assume and no port to hard-code. The inventory is
 * therefore always a last-observed list, and `kelpie describe --json` is the
 * one place that states it as a contract rather than as human-facing output.
 *
 * A Kelpie too old to answer `describe` is still a usable MCP server. That
 * case reports availability and **omits** the inventory rather than inventing
 * an empty one, because "no browsers are on this network" and "this Kelpie
 * cannot tell me" are different facts and the schema keeps them apart.
 */

/** Long enough for an mDNS sweep plus the CLI's own start-up. */
export const KELPIE_DESCRIBE_TIMEOUT_MS = 20_000

/** Kelpie's own discovery default is 3s; this leaves room for a slow phone. */
const KELPIE_DISCOVERY_TIMEOUT_MS = 5_000

/** A describe document is small; anything this large is not one. */
const KELPIE_DESCRIBE_MAX_BYTES = 4 * 1_024 * 1_024

export type KelpieDescription = {
  cliVersion?: string
  devices: KelpieDevice[]
}

type RunResult = { ok: true; stdout: string } | { ok: false }

const KELPIE_DESCRIBE_ARGUMENTS = ['describe', '--json', '--scan-timeout', String(KELPIE_DISCOVERY_TIMEOUT_MS)]

/**
 * The policy's own command for the server, with its trailing `mcp` subcommand
 * replaced by `describe`. Everything before it stays — the program, the script
 * it runs (`node …/kelpie.js`), global flags such as `--browser <alias>` —
 * because describe has to ask the same Kelpie, pinned to the same alias, that
 * the MCP session drives. A command that does not end in `mcp` is not one
 * whose grammar this knows, so it is not described at all: guessing which of
 * its arguments are Kelpie's would run an invocation nobody wrote.
 */
export const kelpieDescribeCommand = (command: readonly string[]): string[] | undefined => {
  if (command.length < 2 || command.at(-1) !== 'mcp') return undefined
  return [...command.slice(0, -1), ...KELPIE_DESCRIBE_ARGUMENTS]
}

/**
 * How describe's tree is found and ended: the coding-session host's own
 * identity-checked control. Describe starts through cross-spawn, not the
 * control's `spawnAgent`, so no job helper is asked for.
 */
const describeTree = createCodingProcessControl(process.platform, {})

/** A describe in flight: its handle, and on POSIX its identity, read while it runs. */
type LiveDescribe = { child: ChildProcess; leader: Promise<CodingProcessIdentity | undefined> }

/** Every describe still running, which the daemon's shutdown stops (`stopKelpieDescribes`). */
const inFlight = new Set<LiveDescribe>()

/**
 * Stops describe and everything it started. On Windows a `.cmd` shim runs as
 * `cmd.exe /d /s /c …`, so killing the child ends only cmd.exe and leaves the
 * Kelpie process under it holding its stdout pipe and its mDNS scan — one
 * more orphan every report sweep — and on any OS a process Kelpie started
 * outlives a kill of Kelpie alone. The tree is read from the process table
 * below describe and each member is checked by its start time right before
 * its own signal: pid by pid on Windows, never `taskkill /T`, which follows
 * parent ids that a reused pid makes somebody else's; describe's own process
 * group and its descendants on POSIX, SIGTERM and then SIGKILL. Describe is
 * this process's own unreaped child, so its start time comes from the same
 * table as its tree, in one read. A describe whose start time cannot be read
 * is still that child, so its handle ends it, and only it.
 *
 * A describe that has already exited while something it started still holds
 * its stdout (so its pipes never closed) is past that: on POSIX what is left
 * of its process group is killed by the start time read when it began
 * (`killExitedGroup`); on Windows such a descendant is out of reach without a
 * Job Object.
 */
const stopDescribeTree = async ({ child, leader }: LiveDescribe): Promise<void> => {
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  if (running() && await describeTree.killChildTree(child)) return
  if (running()) {
    child.kill()
    return
  }
  const identity = await leader
  if (identity) await describeTree.killExitedGroup?.(identity)
}

/**
 * Stops every describe still in flight, whole tree. The daemon's shutdown
 * calls this: on POSIX describe leads a process group of its own, so the
 * signal launchd sends the daemon's group when it stops the job no longer
 * reaches it, and a hung mDNS sweep would outlive a daemon that is no longer
 * there to enforce its budget. (A systemd unit's cgroup and the Windows
 * daemon's kill-on-close job end describe with the daemon either way; a
 * daemon killed outright leaves a POSIX describe to finish on its own.)
 */
export const stopKelpieDescribes = async (): Promise<void> => {
  await Promise.allSettled([...inFlight].map(stopDescribeTree))
}

/**
 * Started exactly as the MCP session starts the same server: through
 * cross-spawn, which is how the SDK's stdio transport resolves a program, so a
 * `kelpie.cmd` shim runs on Windows (plain `execFile` refuses it with EINVAL),
 * and with the SDK's default environment plus the policy's own, so describe
 * sees the `KELPIE_HOME` and `PATH` the session sees rather than the daemon's.
 * On POSIX it leads its own process group, so the group can be ended without
 * the daemon. A describe that fails is stopped, whole tree, before this
 * answers, so no sweep starts beside the last one's leftovers.
 */
const runKelpieDescribe = async (
  command: readonly string[],
  spec: ExecutorLocalMcpServer,
  timeoutMs: number,
): Promise<RunResult> => {
  // Every failure is the same answer here — Kelpie could not describe itself —
  // and the reason why is decided by the MCP probe, which knows whether the
  // program exists at all. Nothing from an error may travel: it carries the
  // argv and a host path.
  let child: ChildProcess
  try {
    child = spawn(command[0]!, command.slice(1), {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      detached: process.platform !== 'win32',
      env: { ...getDefaultEnvironment(), ...spec.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch {
    return { ok: false }
  }
  // Read while describe runs, for its group should it exit and leave that group behind.
  const leader = process.platform === 'win32' || child.pid === undefined
    ? Promise.resolve(undefined)
    : describeTree.identify(child.pid).catch(() => undefined)
  const live: LiveDescribe = { child, leader }
  inFlight.add(live)
  let closed = false
  const result = await new Promise<RunResult>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (outcome: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const chunks: Buffer[] = []
    let bytes = 0
    timer = setTimeout(() => settle({ ok: false }), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > KELPIE_DESCRIBE_MAX_BYTES) {
        settle({ ok: false })
        return
      }
      chunks.push(chunk)
    })
    child.once('error', () => settle({ ok: false }))
    child.once('close', (code) => {
      closed = true
      settle(code === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') } : { ok: false })
    })
  })
  // A describe whose pipes closed left nothing holding them; one that did not is stopped, whatever is left of it.
  try {
    if (!result.ok && !closed) await stopDescribeTree(live)
  } finally {
    inFlight.delete(live)
  }
  return result
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asPort = (value: unknown): number | undefined => {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

/**
 * One entry of Kelpie's describe document, read defensively.
 *
 * Kelpie's grammar is its own and will grow fields we have never heard of, so
 * this reads the fields it needs, tolerates the rest, and drops an entry it
 * cannot state truthfully rather than substituting a default. A device with no
 * id or no address is not a device we could ever drive.
 */
export const kelpieDeviceFromDescribeEntry = (
  entry: unknown,
  observedAt: string,
): KelpieDevice | undefined => {
  const source = asRecord(entry)
  if (!source) return undefined
  const id = asString(source.id)
  const name = asString(source.name)
  const address = asString(source.address) ?? asString(source.ip)
  const port = asPort(source.port)
  if (!id || !name || !address || port === undefined) return undefined
  const display = asRecord(source.display)
  const width = typeof display?.width === 'number' ? display.width : undefined
  const height = typeof display?.height === 'number' ? display.height : undefined
  const candidate = {
    address,
    id,
    name,
    port,
    // Kelpie's describe document always states this, so a missing value means
    // a document we do not understand rather than an unpaired device. Reading
    // it as false is the fail-closed answer: it offers a person a pairing step
    // they can take, where a spurious true would offer a capability that then
    // fails at the first call.
    paired: source.paired === true,
    platform: source.platform,
    lastSeenAt: asString(source.lastSeenAt) ?? observedAt,
    ...(asString(source.model) === undefined ? {} : { model: asString(source.model) }),
    ...(asString(source.engine) === undefined ? {} : { engine: asString(source.engine) }),
    ...(asString(source.version) === undefined ? {} : { version: asString(source.version) }),
    ...(source.runtimeMode === 'gui' || source.runtimeMode === 'headless'
      ? { runtimeMode: source.runtimeMode }
      : {}),
    ...(width === undefined || height === undefined ? {} : { display: { height, width } }),
  }
  const parsed = KelpieDeviceSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

/**
 * Read a `kelpie describe --json` document into the inventory, or return
 * undefined when this Kelpie cannot produce one.
 */
export const kelpieDescriptionFromJson = (
  stdout: string,
  observedAt: string,
): KelpieDescription | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const document = asRecord(parsed)
  if (!document) return undefined
  const discovery = asRecord(document.discovery)
  // A Kelpie that could not browse mDNS at all has not found nothing — it has
  // not looked. Reporting its empty list as an inventory would say "there are
  // no browsers on this network", which is the one thing it cannot know.
  if (discovery?.mdns !== undefined && discovery.mdns !== 'ok') return undefined
  const entries = Array.isArray(discovery?.devices)
    ? discovery.devices
    // Tolerated for a Kelpie that states its instances at the top level.
    : Array.isArray(document.devices) ? document.devices : undefined
  if (!entries) return undefined
  const devices: KelpieDevice[] = []
  for (const entry of entries) {
    // The cap is the wire contract's, so a network full of Kelpies truncates
    // here rather than failing the whole heartbeat downstream.
    if (devices.length >= EXECUTOR_KELPIE_DEVICE_MAXIMUM) break
    const device = kelpieDeviceFromDescribeEntry(entry, observedAt)
    if (device) devices.push(device)
  }
  return {
    devices,
    ...(asString(asRecord(document.cli)?.version) === undefined
      ? {}
      : { cliVersion: asString(asRecord(document.cli)?.version) }),
  }
}

/**
 * Ask the Kelpie behind a named MCP server to describe itself.
 *
 * The command is the one the reviewed policy already named for that server
 * (`kelpieDescribeCommand`) — the executor never goes looking for a `kelpie`
 * binary of its own, because running a program the policy did not name is the
 * thing the policy exists to prevent.
 */
export const describeKelpie = async (
  spec: ExecutorLocalMcpServer,
  options: {
    run?: (command: readonly string[], spec: ExecutorLocalMcpServer, timeoutMs: number) => Promise<RunResult>
    timeoutMs?: number
  } = {},
): Promise<KelpieDescription | undefined> => {
  const command = kelpieDescribeCommand(spec.command)
  if (!command) return undefined
  const run = options.run ?? runKelpieDescribe
  const result = await run(command, spec, options.timeoutMs ?? KELPIE_DESCRIBE_TIMEOUT_MS)
  if (!result.ok) return undefined
  return kelpieDescriptionFromJson(result.stdout, new Date().toISOString())
}
