import { attachEffectTransport } from './effect-transport.js'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { CodingProcessControl } from './process-control.js'
import type { CodingProcessIdentity } from './types.js'
import { run, startTimeOfLive, treeOf, membersOf, isStill, recorded, ownChild, TOOL_TIMEOUT_MS, type ProcessTable } from './process-control-common.js'

const system32 = (file: string): string => join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', file)

const powershellPath = (): string => system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe'))
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command']

const powershell = async (script: string): Promise<string> => (
  (await run(powershellPath(), [...POWERSHELL_ARGS, script])).stdout
)

type PowerShellExchange = {
  /**
   * Whether the script handled all of `reply`'s answer, which it says with
   * its closing `.` line: false for a script that failed, printed no `.`
   * line, was never cued, or was ended partway through the lines it was sent
   * — by its budget, say, while a kill slowed by load was still going on.
   */
  done: Promise<boolean>
  /** Lets a `cued` script go on past the line it waits for. */
  cue: () => void
}

const DOT_LINE = /(?:^|\n)\.\r?\n/u

/**
 * Runs a PowerShell `script` that prints up to a `.` line, then reads lines
 * until its input ends and prints a closing `.` line once it has handled
 * them all: `reply` answers what it printed before the first. A `cued`
 * script first reads one line of its own and does nothing until `cue` sends
 * it, so PowerShell's start is paid before the answer is needed; one whose
 * input ends first (this process exited) exits unused. Each half gets the
 * tool budget of its own once it is under way.
 */
export const powershellExchange = (
  script: string, reply: (printed: string) => string[] | Promise<string[]>, cued = false,
): PowerShellExchange => {
  const child = spawn(powershellPath(), [...POWERSHELL_ARGS, script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  let timer: NodeJS.Timeout | undefined
  const budget = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => child.kill(), TOOL_TIMEOUT_MS)
  }
  if (!cued) budget()
  let printed = ''
  let answered = false
  /** What it printed after the first `.` line; unset until it printed one. */
  let after: string | undefined
  let closed = false
  child.stdin.on('error', () => undefined)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (answered) {
      if (after !== undefined && !closed) closed = DOT_LINE.test(after += chunk)
      return
    }
    printed += chunk
    const end = DOT_LINE.exec(printed)
    if (!end && printed.length <= 8 * 1024 * 1024) return
    answered = true
    budget()
    if (end) after = printed.slice(end.index + end[0].length)
    void Promise.resolve(end ? reply(printed.slice(0, end.index)) : []).then(lines => {
      child.stdin.end(lines.map((line) => `${line}\n`).join(''))
    }).catch(() => child.stdin.end())
  })
  const done = new Promise<boolean>((settle) => {
    const finish = (): void => {
      clearTimeout(timer)
      settle(closed)
    }
    child.once('error', finish)
    child.once('close', finish)
  })
  return {
    done,
    cue: () => {
      budget()
      child.stdin.write('go\n')
    },
  }
}

/**
 * Windows start times are `Process.StartTime` as a UTC FILETIME, from one
 * source for a single process and for the whole table alike, so the two
 * always compare equal for the same process.
 */
const WINDOWS_TABLE = [
  "$ErrorActionPreference = 'Stop';",
  '$s = @{}; foreach ($p in Get-Process) { try { $s[$p.Id] = $p.StartTime.ToFileTimeUtc() } catch {} }',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object {',
  '"$($_.ProcessId) $($_.ParentProcessId) $($s[[int]$_.ProcessId])" }',
].join(' ')

/**
 * A whole Windows kill in one PowerShell: it prints the table and a `.` line,
 * then reads back `<pid> <startedAt>` lines, in order, kills each process
 * through a handle it holds while it compares that process's start time, and
 * prints a closing `.` line once its input has ended. So
 * nothing is killed on a table that has gone stale, not even in the moment
 * between the check and the kill — Windows never hands on the pid of a
 * process somebody still holds a handle to — and a kill costs one PowerShell
 * rather than two and a `taskkill` per member, which under load was most of
 * the five seconds a dead host's agent has. A process that refuses the handle
 * is checked and killed by pid at once, as `taskkill /F` would.
 */
export const WINDOWS_KILL = [
  WINDOWS_TABLE,
  "; '.'; [Console]::Out.Flush()",
  '; $refused = $false; while ($null -ne ($line = [Console]::In.ReadLine())) { $target, $started, $until = $line.Split(" ")',
  '; try { $p = Get-Process -Id ([int]$target) -ErrorAction Stop; try { $null = $p.Handle } catch {}',
  '; if ($p.StartTime.ToFileTimeUtc() -eq [long]$started) {',
  '; if ($until -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$until) { $refused = $true }',
  'else { $p.Kill() } } } catch {} }',
  "; if ($refused) { '!' } else { '.' }",
].join(' ')

/**
 * The same kill, started ahead of need: it loads the cmdlets the table uses —
 * without querying anything, so a standby costs WMI nothing — then waits for
 * its cue line, and exits unused if its input ends first. Cold, a
 * PowerShell's start and its CIM module were seconds of that kill on a loaded
 * machine; warm, the table is a few hundred milliseconds.
 */
export const WINDOWS_KILL_ON_CUE = [
  '$null = Get-Process -Id $PID; Import-Module CimCmdlets',
  '; if ($null -eq [Console]::In.ReadLine()) { exit }; ',
  WINDOWS_KILL,
].join('')

const parseWindowsTable = (text: string): ProcessTable => {
  const rows: ProcessTable = new Map()
  for (const line of text.split(/\r?\n/u)) {
    const [pidText, ppidText, startedText] = line.trim().split(/\s+/u)
    if (!pidText || !ppidText || !/^\d+$/u.test(pidText)) continue
    rows.set(Number(pidText), {
      ppid: Number(ppidText), ...(startedText && /^\d+$/u.test(startedText) ? { started: startedText } : {}),
    })
  }
  return rows
}

export const windowsControl = (
  jobHelper: string | undefined, refusal: string | undefined, killOnCue: string,
): CodingProcessControl => {
  const startedAt = async (pid: number): Promise<string | undefined> => {
    const answer = (await powershell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToFileTimeUtc() }`,
    )).trim()
    return /^\d+$/u.test(answer) ? answer : undefined
  }
  const table = async (): Promise<ProcessTable> => parseWindowsTable(await powershell(WINDOWS_TABLE))
  /**
   * What `WINDOWS_KILL` is sent back: the root first (through the helper, the
   * whole job) — killing it takes a moment, and each member is looked at
   * again right before its own kill. Never `taskkill /T`: that walks parent
   * ids as they are now, which a reused pid makes somebody else's.
   */
  const targets = (
    before: ProcessTable, identity: CodingProcessIdentity, snapshot: readonly CodingProcessIdentity[],
  ): string[] => {
    const members = membersOf(identity, snapshot, treeOf(identity, before, false))
    const root = isStill(before, identity) ? [`${identity.pid} ${identity.startedAt}`] : []
    return [...root, ...[...members].map(([pid, started]) => `${pid} ${started}`)]
  }
  const killTree: CodingProcessControl['killTree'] = async (identity, snapshot = [], effect) => {
    let authorityError: unknown
    const exchange = powershellExchange(WINDOWS_KILL, async (printed) => {
      try {
        await effect?.consume()
        effect?.assertLive()
        return targets(parseWindowsTable(printed), identity, snapshot).map(line =>
          effect ? `${line} ${Date.parse(effect.scope.expiresAt)}` : line)
      } catch (error) { authorityError = error; return [] }
    })
    const done = await exchange.done
    if (authorityError) throw authorityError
    if (!done) {
      throw new Error('Windows process termination exchange did not complete.')
    }
  }
  const containedLaunch = jobHelper
    ? (command: string, args: readonly string[]) => ({ command: jobHelper, args: ['job-run', '--', command, ...args] })
    : undefined
  return {
    ...(containedLaunch ? { containment: 'windows_job' as const, containedLaunch } : {}),
    stopTree: async (identity, snapshot = [], effect) => {
      const result = await run(powershellPath(), [...POWERSHELL_ARGS, WINDOWS_TABLE])
      if (result.failed || !result.stdout.trim() || !recorded(identity)) return 'unknown'
      const before = parseWindowsTable(result.stdout)
      const rootPresent = isStill(before, identity)
      if (!rootPresent && identity.containment !== 'windows_job') return 'unknown'
      const members = membersOf(identity, snapshot, treeOf(identity, before, false))
      try { await killTree(identity, [...members].map(([pid, startedAt]) => ({ pid, startedAt })), effect) }
      catch (error) { if (effect) throw error; return 'unknown' }
      const after = await run(powershellPath(), [...POWERSHELL_ARGS, WINDOWS_TABLE])
      if (after.failed || !after.stdout.trim()) return 'unknown'
      const checked = parseWindowsTable(after.stdout)
      if ([identity, ...[...members].map(([pid, startedAt]) => ({ pid, startedAt }))].some((member) => {
        const row = checked.get(member.pid)
        return row !== undefined && (row.started === undefined || row.started === member.startedAt)
      })) return 'unknown'
      // A process table cannot reveal a descendant that already escaped and
      // reparented. Only the birth Job Object covers that missing history.
      return identity.containment === 'windows_job' ? 'stopped' : 'unknown'
    },
    ...(refusal ? { refusal } : {}),
    // Through the helper the program is resolved and started by `CreateProcessW`
    // inside the job; the host still holds the same three pipes.
    spawnAgent: (command, args, options) => {
      const bound = jobHelper && options.sessionEffect
      const child = spawn(
      jobHelper ?? command,
      jobHelper ? [bound ? 'job-run-authorized' : 'job-run', '--', command, ...args] : args,
      { cwd: options.cwd, env: options.env, stdio: bound ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        windowsHide: true, shell: false },
      )
      if (bound) attachEffectTransport(child, 3, options.sessionEffect, { command, args, cwd: options.cwd })
      return child
    },
    identify: async (pid) => {
      const started = await startTimeOfLive(pid, startedAt)
      return started === undefined ? undefined : { pid, startedAt: started }
    },
    descendants: async (identity) => treeOf(identity, await table(), false),
    killTree,
    killChildTree: async (child) => {
      let found = false
      await powershellExchange(WINDOWS_KILL, (printed) => {
        const before = parseWindowsTable(printed)
        const root = ownChild(child, before)
        found = root !== undefined
        return root ? targets(before, root, []) : []
      }).done
      return found
    },
    standbyKill: (identity) => {
      /** Who the standby's table showed below the agent. */
      let members: CodingProcessIdentity[] = []
      const reply = (printed: string): string[] => {
        const before = parseWindowsTable(printed)
        members = treeOf(identity, before, false)
        return targets(before, identity, [])
      }
      const standing = powershellExchange(killOnCue, reply, true)
      let fired: Promise<void> | undefined
      // A standby that died before its cue, read no table or was ended before its list was done: a cold kill does
      // it. It goes by the members the standby saw, since a root killed first leaves nothing to walk down from.
      return () => fired ??= (async () => {
        standing.cue()
        if (!await standing.done) await killTree(identity, members)
      })()
    },
  }
}
