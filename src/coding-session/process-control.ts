import type { SessionEffectAuthority } from './session-effect-authority.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'

import { packagedNativeHelperPath } from '../state-security.js'
import type { CodingProcessIdentity } from './types.js'
import { run, delay, alive, startTimeOfLive, recorded, isStill, notEarlier, treeOf, membersOf, stillThere, ownChild,
  TOOL_TIMEOUT_MS, type ProcessTable, type PsRunner } from './process-control-common.js'
import { windowsControl, WINDOWS_KILL_ON_CUE } from './process-control-windows.js'
export { powershellExchange, WINDOWS_KILL } from './process-control-windows.js'
export type { PsRunner } from './process-control-common.js'

/**
 * How a session host starts, recognises and kills a coding agent's process
 * tree, behind one interface so each OS's containment is its own.
 *
 * POSIX puts the agent in its own process group and sweeps descendants from a
 * process table read before signalling, which also catches a grandchild that
 * called `setsid`; on Linux the host itself runs in a `systemd-run --user`
 * unit when a user manager is reachable (see `host-spawn.ts`), whose cgroup
 * catches whatever escapes both. On Windows a packaged runtime starts the
 * agent through the native helper's `job-run`, which holds it in a Job Object
 * with kill-on-close: the helper's pid is the recorded identity, and killing
 * the helper — or the host dying, which the helper watches — kills everything
 * in the job, including a grandchild whose parent already exited. A
 * development run has no verified helper, and falls back to killing the tree
 * it can see, pid by pid, which misses exactly that grandchild. A packaged
 * runtime whose helper is missing starts no agent. A Windows kill is one
 * PowerShell that reads the table and then terminates each process through a
 * handle it holds while it checks that process's start time.
 * Wherever neither a Job Object nor a unit's cgroup would end an agent whose
 * host died, the host starts it through the agent guard (`agent-guard.ts`),
 * which kills it with these same calls when the host's pipe closes. Kelpie
 * detection ends a `describe` it gave up on with them too (`kelpie-detect.ts`).
 *
 * Every signal checks an identity (pid plus process start time) first, so a
 * pid the OS has since handed to somebody else is never signalled. That holds
 * for the tree too: descendants are read only below a root that is still the
 * recorded process, each one carries its own start time, and each is checked
 * again right before its own signal. An identity without a start time is
 * unknown and is never killed.
 */
export type CodingProcessControl = {
  /** Birth containment, recorded with the child rather than inferred after it exits. */
  containment?: 'windows_job' | 'posix_group'
  /** Positive stop evidence. Absence after an uncontained root exited cannot prove its descendants stopped. */
  stopTree?: (identity: CodingProcessIdentity, snapshot?: readonly CodingProcessIdentity[], effect?: SessionEffectAuthority) => Promise<'stopped' | 'unknown'>
  /**
   * How to start a program inside its own Job Object, for a caller that
   * spawns it itself (a local app over stdio): Windows with the job helper
   * only. What it starts is recorded with `containment`, which is what lets
   * `stopTree` prove the whole tree stopped.
   */
  containedLaunch?: (command: string, args: readonly string[]) => { command: string; args: string[] }
  /** Set when this host cannot contain an agent; starting one fails with this reason. */
  refusal?: string
  spawnAgent: (command: string, args: string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; sessionEffect?: SessionEffectAuthority
  }) => ChildProcess
  identify: (pid: number) => Promise<CodingProcessIdentity | undefined>
  /**
   * The identity to record for what `spawnAgent` started, when that process
   * is not the agent itself (the guard reports its agent's); otherwise the
   * spawned process's own, by `identify`.
   */
  identifySpawned?: (child: ChildProcess) => Promise<CodingProcessIdentity | undefined>
  /** Ends the agent's input; the child's stdin is simply ended when this is absent. */
  endInput?: (child: ChildProcess) => void
  /**
   * Every live descendant of the recorded process, read before anything is
   * signalled; none unless it is still that process.
   */
  descendants: (identity: CodingProcessIdentity) => Promise<CodingProcessIdentity[]>
  /** Kills the process and its tree while it is still the one recorded, and each snapshot member still its own. */
  killTree: (identity: CodingProcessIdentity, snapshot?: readonly CodingProcessIdentity[],
    effect?: SessionEffectAuthority) => Promise<void>
  /**
   * Kills a process this one started and has not reaped, and its tree, with
   * its start time read in the same table as its descendants rather than by
   * an `identify` first. False when the table showed none for it (it had
   * exited, or the table could not be read): the caller's own handle is then
   * all that can end it.
   */
  killChildTree: (child: ChildProcess) => Promise<boolean>
  /**
   * A `killTree` of `identity` made ready now, for a caller that has to kill
   * fast later: the answer runs it. Only where a kill is slow to start —
   * Windows, whose kill is a PowerShell — and it lives until it runs or this
   * process exits.
   */
  standbyKill?: (identity: CodingProcessIdentity) => () => Promise<void>
  /**
   * POSIX only: kills what is left of the process group `leader` led, once
   * the leader itself has exited and been reaped — a process it started that
   * still holds its stdout, say. A pid that names a live process group is never
   * handed out again, so while any member lives the group is still the
   * leader's; each member must also have started no earlier than the leader,
   * and none is signalled once a process of the leader's pid exists again.
   * False when nothing of the group was left. Windows has no such group, and
   * a descendant of an exited process is out of reach there without a Job
   * Object.
   */
  killExitedGroup?: (leader: CodingProcessIdentity) => Promise<boolean>
}

const TERM_GRACE_MS = 2_000

/**
 * The native helper beside the packaged Node runtime, when this process is the
 * installed package — the same helper, found the same way, that secures the
 * executor's state. A development run has none and gets `undefined`.
 */
export const packagedJobHelper = (environment: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (environment.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return undefined
  const path = packagedNativeHelperPath()
  try {
    const entry = lstatSync(path)
    return entry.isFile() && !entry.isSymbolicLink() ? path : undefined
  } catch {
    return undefined
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `ps -o lstart=` in the C locale and UTC (`Tue Sep 23 10:00:00 2026`) as
 * epoch seconds, so neither a time-zone change nor a locale can make the same
 * process read as another.
 */
export const parsePsStartTime = (text: string): string | undefined => {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(text.trim())
  const month = match ? MONTHS.indexOf(match[1]!) : -1
  if (!match || month < 0) return undefined
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number) as [number, number, number, number, number]
  return String(Date.UTC(year, month, day, hours, minutes, seconds) / 1_000)
}

const PS_ENVIRONMENT = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }

/** `/proc/<pid>/stat` after the parenthesised command name: state, ppid, pgrp, … field 22 is starttime. */
const procStat = (text: string): { ppid: number; pgid: number; started?: string } | undefined => {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  if (!fields[1] || !fields[2]) return undefined
  return { ppid: Number(fields[1]), pgid: Number(fields[2]), ...(/^\d+$/u.test(fields[19] ?? '') ? { started: fields[19] } : {}) }
}

const systemPs: PsRunner = async (args, timeoutMs) => {
  const { stdout, failed } = await run('/bin/ps', args, PS_ENVIRONMENT, timeoutMs)
  return failed ? undefined : stdout
}

const posixControl = (
  platform: NodeJS.Platform, termGraceMs: number, ps: PsRunner, log: (message: string) => void = () => undefined,
  signalProcess: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): CodingProcessControl => {
  const startedAt = async (pid: number): Promise<string | undefined> => {
    if (platform === 'linux') return procStat(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''))?.started
    return parsePsStartTime(await ps(['-o', 'lstart=', '-p', String(pid)], TOOL_TIMEOUT_MS) ?? '')
  }
  /**
   * Every process, or `undefined` when the table could not be read — a `ps`
   * that timed out under load, say. That is no reading at all, never an empty
   * table: read as one, it would say the whole tree had exited.
   */
  const table = async (timeoutMs = TOOL_TIMEOUT_MS): Promise<ProcessTable | undefined> => {
    const rows: ProcessTable = new Map()
    if (platform === 'linux') {
      const names = (await readdir('/proc').catch(() => [] as string[])).filter((name) => /^\d+$/u.test(name))
      let incomplete = false
      await Promise.all(names.map(async (name) => {
        const stat = procStat(await readFile(`/proc/${name}/stat`, 'utf8').catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code
          // Linux may retain the proc entry after the task exits: reading its
          // stat then fails with ESRCH rather than ENOENT. Both mean that this
          // enumerated process is gone, not that the whole table is unreadable.
          if (code !== 'ENOENT' && code !== 'ESRCH') incomplete = true
          return ''
        }))
        if (stat) rows.set(Number(name), stat)
      }))
      return rows.size > 0 && !incomplete ? rows : undefined
    }
    for (const line of (await ps(['-A', '-o', 'pid=,ppid=,pgid=,lstart='], timeoutMs) ?? '').split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
      if (!match) continue
      const started = parsePsStartTime(match[4]!)
      rows.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), ...(started ? { started } : {}) })
    }
    return rows.size > 0 ? rows : undefined
  }
  /**
   * The table a SIGKILL goes by, once `gone` finds nothing of the tree left
   * in it or the grace is over. Each read inside the grace gets only what is
   * left of it, and one that fails leaves the wait going by the last table
   * read. A SIGKILL is checked against a fresh table, so a grace that ended on
   * a failed read gets one more with the whole tool budget, which bounds the
   * overrun to that one read; `undefined` when it fails too, and then nothing
   * can be checked, so nothing more is signalled and `log` says so: a member
   * that ignores SIGTERM may still be running.
   */
  const afterGrace = async (
    before: ProcessTable, gone: (table: ProcessTable) => boolean,
  ): Promise<ProcessTable | undefined> => {
    const deadline = Date.now() + termGraceMs
    let last = before
    let read: ProcessTable | undefined
    do {
      await delay(100)
      read = await table(Math.max(deadline - Date.now(), 100))
      last = read ?? last
    } while (Date.now() < deadline && !gone(last))
    return read ?? table()
  }
  const send = (pid: number, signal: NodeJS.Signals): void => {
    try {
      signalProcess(pid, signal)
    } catch {
      // Already gone.
    }
  }
  /** The kill, from a table read before anything is signalled. */
  const killFrom = async (
    before: ProcessTable, identity: CodingProcessIdentity, snapshot: readonly CodingProcessIdentity[],
    effect?: SessionEffectAuthority,
  ): Promise<'stopped' | 'unknown'> => {
    const rootWasOurs = isStill(before, identity)
    const members = membersOf(identity, snapshot, treeOf(identity, before, true))
    /** Signals what is still ours; `false` once nothing is. */
    const signal = (current: ProcessTable, name: NodeJS.Signals): boolean => {
      const rootIsOurs = rootWasOurs && isStill(current, identity)
      // A pid that names a live process group is never handed out again, so
      // once the leader is gone its group is still only ever ours.
      if (rootWasOurs && (rootIsOurs || !current.has(identity.pid))) send(-identity.pid, name)
      if (rootIsOurs) send(identity.pid, name)
      const pending = stillThere(members, current)
      for (const pid of pending) send(pid, name)
      return rootIsOurs || pending.length > 0
    }
    await effect?.consume()
    effect?.assertLive()
    if (!signal(before, 'SIGTERM')) return 'unknown'
    const gone = (current: ProcessTable): boolean => (
      !isStill(current, identity) && stillThere(members, current).length === 0
    )
    const after = await afterGrace(before, gone)
    if (after) { await effect?.consume(); effect?.assertLive(); signal(after, 'SIGKILL') }
    else log(`no process table after the grace: SIGKILL skipped for pid ${identity.pid}'s group and tree (${members.size + 1} processes)`)
    if (!after) return 'unknown'
    // Signal delivery is not termination. Require a fresh table after it.
    await delay(100)
    const checked = await table()
    if (!checked || !gone(checked)) return 'unknown'
    // Group/table sweeps cannot prove an escaped, already reparented child is
    // absent. A native cgroup/containment proof must supply a stopped verdict.
    return 'unknown'
  }
  return {
    containment: 'posix_group',
    stopTree: async (identity, snapshot = [], effect) => {
      const before = await table()
      return before ? killFrom(before, identity, snapshot, effect) : 'unknown'
    },
    // Its own process group, so the group can be killed without the host.
    spawnAgent: (command, args, options) => spawn(command, args, {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: true,
    }),
    identify: async (pid) => {
      const started = await startTimeOfLive(pid, startedAt)
      return started === undefined ? undefined : { pid, startedAt: started }
    },
    descendants: async (identity) => treeOf(identity, await table() ?? new Map(), true),
    killTree: async (identity, snapshot = [], effect) => {
      const before = await table()
      if (before) await killFrom(before, identity, snapshot, effect)
    },
    killChildTree: async (child) => {
      const before = await table()
      const root = before ? ownChild(child, before) : undefined
      if (before && root) await killFrom(before, root, [])
      return root !== undefined
    },
    killExitedGroup: async (leader) => {
      const before = await table()
      if (!before || !recorded(leader) || before.has(leader.pid)) return false
      const members = new Map<number, string>()
      for (const [pid, row] of before) {
        if (row.pgid === leader.pid && notEarlier(row.started, leader.startedAt)) members.set(pid, row.started)
      }
      const signal = (current: ProcessTable, name: NodeJS.Signals): boolean => {
        const pending = current.has(leader.pid) ? [] : stillThere(members, current)
        if (pending.length > 0) send(-leader.pid, name)
        for (const pid of pending) send(pid, name)
        return pending.length > 0
      }
      if (!signal(before, 'SIGTERM')) return false
      const after = await afterGrace(before, (current) => stillThere(members, current).length === 0)
      if (after) signal(after, 'SIGKILL')
      else log(`no process table after the grace: SIGKILL skipped for the group pid ${leader.pid} led (${members.size} processes)`)
      return true
    },
  }
}

/**
 * The control for this host. A packaged Windows runtime without its native
 * helper refuses to start agents at all: without the Job Object nothing
 * contains a grandchild that outlives its parent, and the development
 * fallback is only for development. `termGraceMs` is how long a POSIX tree
 * has between SIGTERM and SIGKILL, and `ps` is how the table is read where
 * there is no `/proc`. `log` hears of a SIGKILL skipped because no table could
 * be read to check it against. `killOnCue` is the Windows standby's script,
 * unless a test stands in one that stops partway through.
 */
export const createCodingProcessControl = (
  platform: NodeJS.Platform = process.platform,
  options: {
    jobHelper?: string; packaged?: boolean; termGraceMs?: number; ps?: PsRunner
    log?: (message: string) => void; killOnCue?: string
    signal?: (pid: number, signal: NodeJS.Signals) => void
  } = {
    jobHelper: platform === 'win32' ? packagedJobHelper() : undefined,
    packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  },
): CodingProcessControl => (
  platform === 'win32'
    ? windowsControl(
      options.jobHelper, options.packaged && !options.jobHelper ? 'containment_failed' : undefined,
      options.killOnCue ?? WINDOWS_KILL_ON_CUE,
    )
    : posixControl(platform, options.termGraceMs ?? TERM_GRACE_MS, options.ps ?? systemPs, options.log, options.signal)
)

export const codingProcessIsAlive = alive
