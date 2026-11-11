import { execFile } from 'node:child_process'

/**
 * Messages, driven through AppleScript (`/usr/bin/osascript`). The address and
 * the text travel as `argv`, never inside the script's source, so nothing a
 * model writes can become AppleScript. macOS asks the person at the Mac, once,
 * whether Nessie Computer may control Messages (Automation); a refusal is
 * error -1743.
 */
export const OSASCRIPT = '/usr/bin/osascript'
/** Inside Nessie's 60-second command deadline, with room to confirm the send. */
const SCRIPT_TIMEOUT_MS = 20_000

const SEND_SCRIPT = [
  'on run argv',
  '  set targetHandle to item 1 of argv',
  '  set messageText to item 2 of argv',
  '  tell application "Messages"',
  '    set targetService to 1st account whose service type = iMessage and enabled is true',
  '    set targetBuddy to participant targetHandle of targetService',
  '    send messageText to targetBuddy',
  '  end tell',
  'end run',
]

/** Counts the enabled iMessage accounts; this is also what makes macOS ask for Automation. */
const PROBE_SCRIPT = [
  'tell application "Messages"',
  '  return count of (accounts whose service type = iMessage and enabled is true)',
  'end tell',
]

export type ScriptOutcome = { ok: true; output: string } | { ok: false; failure: MessagesFailure; detail: string }
/** `automation`: control of Messages refused. `account`: no enabled iMessage account. */
export type MessagesFailure = 'automation' | 'account' | 'failed'

export type ScriptRunner = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

const runOsascript: ScriptRunner = (args) => new Promise((settle) => {
  execFile(OSASCRIPT, [...args], { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    const exit = (error as { code?: unknown } | null)?.code
    const code = error ? typeof exit === 'number' ? exit : null : 0
    settle({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
  })
})

const scriptArguments = (lines: readonly string[]): string[] => lines.flatMap((line) => ['-e', line])

/** Error numbers AppleScript prints as `(-1743)` at the end of its message. */
const errorNumber = (stderr: string): number | null => {
  const match = /\((-?\d+)\)\s*$/u.exec(stderr.trim())
  return match ? Number(match[1]) : null
}

export const classifyScriptFailure = (stderr: string): MessagesFailure => {
  const number = errorNumber(stderr)
  // -1743: not authorized to send Apple events. -1744: the user must consent first.
  if (number === -1743 || number === -1744) return 'automation'
  // -1728: "Can't get account 1 whose …" — no enabled iMessage account.
  if (number === -1728 && /account/iu.test(stderr)) return 'account'
  return 'failed'
}

type ScriptResult = { code: number | null; stdout: string; stderr: string }

const outcomeOf = async (run: Promise<ScriptResult>): Promise<ScriptOutcome> => {
  const result = await run
  if (result.code === 0) return { ok: true, output: result.stdout.trim() }
  const detail = result.stderr.trim().slice(0, 500) || `osascript exited with ${String(result.code)}`
  return { ok: false, failure: classifyScriptFailure(result.stderr), detail }
}

export type MessagesApp = {
  /** Whether Messages answers, and with how many enabled iMessage accounts. */
  probe: () => Promise<ScriptOutcome>
  send: (handle: string, text: string) => Promise<ScriptOutcome>
}

export const createMessagesApp = (run: ScriptRunner = runOsascript): MessagesApp => ({
  probe: () => outcomeOf(run(scriptArguments(PROBE_SCRIPT))),
  send: (handle, text) => outcomeOf(run([...scriptArguments(SEND_SCRIPT), handle, text])),
})
