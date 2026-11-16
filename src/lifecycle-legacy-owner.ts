import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** A PID now owned by a different OS principal cannot be this owner's lifecycle process. */
export const legacyLifecycleOwnerAbsent = async (pid: number, startedAt?: string): Promise<boolean> => {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return false
  const root = process.env.SystemRoot
  if (!root || !win32.isAbsolute(root)) return false
  // Read-only, bounded metadata. No executable-name guesses and no signal to the observed process.
  const script = [
    "$ErrorActionPreference='Stop'",
    `$first=Get-Process -Id ${pid}`,
    '$birth=$first.StartTime.ToFileTimeUtc().ToString()',
    `$entry=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    '$owner=Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid',
    'if($owner.ReturnValue -ne 0 -or -not $owner.Sid){throw "owner_unknown"}',
    `$second=Get-Process -Id ${pid}`,
    'if($birth -ne $second.StartTime.ToFileTimeUtc().ToString()){throw "generation_changed"}',
    '$selfSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '[pscustomobject]@{startedAt=$birth;differentOwner=($owner.Sid -ne $selfSid)}|ConvertTo-Json -Compress',
  ].join('; ')
  try {
    const result = await execute(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5_000, maxBuffer: 4_096, windowsHide: true })
    const value = JSON.parse(result.stdout) as Record<string, unknown>
    return typeof value.startedAt === 'string' && /^[1-9][0-9]*$/u.test(value.startedAt)
      && (startedAt === undefined || startedAt === value.startedAt) && value.differentOwner === true
  } catch { return false }
}
