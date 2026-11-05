import { execFile, type ChildProcess } from 'node:child_process'
import type { CodingProcessIdentity } from './types.js'

export const TOOL_TIMEOUT_MS = 10_000

export type ProcessRow = { ppid: number; pgid?: number; started?: string }
export type ProcessTable = Map<number, ProcessRow>

/** What `file` printed, and whether it failed: timed out, was killed or exited non-zero. */
export const run = (
  file: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = TOOL_TIMEOUT_MS,
): Promise<{ stdout: string; failed: boolean }> => new Promise((settle) => {
  execFile(file, args, {
    timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}),
  }, (error, stdout) => {
    settle({ stdout: String(stdout), failed: error !== null })
  })
})

/**
 * How `ps` runs where there is no `/proc` (macOS): what it printed, or
 * `undefined` when it failed. `/bin/ps`, in the C locale and UTC, unless a
 * test stands in its own.
 */
export type PsRunner = (args: string[], timeoutMs: number) => Promise<string | undefined>

export const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The start time of a process that is still alive, read again when the read
 * fails: PowerShell and `ps` can time out under load, and a start time that
 * could not be read leaves nothing a later kill could check against.
 */
export const startTimeOfLive = async (
  pid: number, read: (pid: number) => Promise<string | undefined>,
): Promise<string | undefined> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await read(pid)
    if (value !== undefined || !alive(pid)) return value
  }
  return undefined
}

export const recorded = (
  identity: CodingProcessIdentity,
): identity is CodingProcessIdentity & { startedAt: string } => (
  typeof identity.startedAt === 'string' && /^\d+$/u.test(identity.startedAt)
)

/** Whether `table` shows exactly the recorded process: same pid, same start time. */
export const isStill = (table: ProcessTable, identity: CodingProcessIdentity): boolean => (
  recorded(identity) && table.get(identity.pid)?.started === identity.startedAt
)

/** Every start time here is a decimal count (FILETIME, clock ticks or epoch seconds), so order is numeric. */
export const notEarlier = (started: string | undefined, than: string): started is string => (
  started !== undefined && /^\d+$/u.test(started) && BigInt(started) >= BigInt(than)
)

/**
 * The recorded process's descendants in `table`, and on POSIX the rest of its
 * process group, each started no earlier than its parent — a "child" created
 * before its parent is a reused pid, not a child. Nothing at all unless the
 * root is still the recorded process: the children of whoever inherited its
 * pid are nobody this host started.
 */
export const treeOf = (
  identity: CodingProcessIdentity, table: ProcessTable, withGroup: boolean,
): CodingProcessIdentity[] => {
  if (!isStill(table, identity) || !recorded(identity)) return []
  const byParent = new Map<number, number[]>()
  for (const [pid, row] of table) byParent.set(row.ppid, [...byParent.get(row.ppid) ?? [], pid])
  const found = new Map<number, string>()
  const queue = [{ pid: identity.pid, started: identity.startedAt }]
  while (queue.length > 0 && found.size < 4_096) {
    const parent = queue.shift()!
    for (const pid of byParent.get(parent.pid) ?? []) {
      const started = table.get(pid)?.started
      if (pid === identity.pid || found.has(pid) || !notEarlier(started, parent.started)) continue
      found.set(pid, started)
      queue.push({ pid, started })
    }
  }
  if (withGroup) {
    for (const [pid, row] of table) {
      if (row.pgid !== identity.pid || pid === identity.pid || found.has(pid)) continue
      if (notEarlier(row.started, identity.startedAt)) found.set(pid, row.started)
    }
  }
  return [...found].map(([pid, startedAt]) => ({ pid, startedAt }))
}

/** The members to signal: the snapshot's and a fresh walk's, each by its own start time. */
export const membersOf = (
  identity: CodingProcessIdentity, snapshot: readonly CodingProcessIdentity[], fresh: readonly CodingProcessIdentity[],
): Map<number, string> => {
  const members = new Map<number, string>()
  for (const entry of [...snapshot, ...fresh]) {
    if (recorded(entry) && entry.pid !== identity.pid) members.set(entry.pid, entry.startedAt)
  }
  return members
}

export const stillThere = (members: Map<number, string>, table: ProcessTable): number[] => (
  [...members].filter(([pid, started]) => table.get(pid)?.started === started).map(([pid]) => pid)
)

/**
 * `child`'s identity by `table`, while this process has not yet reaped it.
 * Until then its pid is still its own — a zombie's on POSIX, held by Node's
 * open handle on Windows — so if it is unreaped now it was when the table was
 * read, and the table's row for that pid is the child's.
 */
export const ownChild = (child: ChildProcess, table: ProcessTable): CodingProcessIdentity | undefined => {
  const started = child.pid === undefined ? undefined : table.get(child.pid)?.started
  if (!started || child.exitCode !== null || child.signalCode !== null) return undefined
  return { pid: child.pid!, startedAt: started }
}
