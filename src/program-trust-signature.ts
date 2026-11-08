import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'

import { programTrustSignatureCovers } from './program-trust.js'

/**
 * "Apps from UnlikeOtherAI" (contract §6.2): an executable counts only when
 * the operating system verifies its code signature and that signature names
 * UnlikeOtherAI. A file name, a folder, a bundle identifier on its own or a
 * manifest beside the file decide nothing, because anybody can write those.
 *
 * - macOS: `codesign --verify --strict` against a requirement for a Developer
 *   ID Application certificate, issued under Apple's Developer ID
 *   intermediate, whose team is UnlikeOtherAI's. An executable inside an app
 *   bundle is verified as that bundle (its sealed resources and Info.plist
 *   included), which is how a `com.unlikeotherai.*` app's own binary
 *   qualifies; the same binary copied out of its bundle does not.
 * - Windows: `Get-AuthenticodeSignature`, the shell's WinVerifyTrust wrapper,
 *   must answer `Valid` with UnlikeOtherAI's exact publisher subject.
 * - Linux has no OS-held signature on an ordinary executable, so nothing is
 *   covered there; the owner names such programs themselves.
 *
 * The verdict is about the resolved file at the moment it is checked; the
 * caller launches that same absolute path rather than a name the OS would
 * look up again.
 */

/** UnlikeOtherAI s.r.o.'s Apple Developer team, as its Developer ID certificates carry it. */
export const UNLIKEOTHERAI_APPLE_TEAM_ID = '23B7GTLBN7'

/** UnlikeOtherAI's Windows publisher, exactly as its Artifact Signing certificates state it. */
export const UNLIKEOTHERAI_WINDOWS_PUBLISHER =
  'CN=UnlikeOtherAI s.r.o., O=UnlikeOtherAI s.r.o., L=Mnichovice, S=Central Bohemia, C=CZ'

/**
 * Apple's Developer ID requirement, pinned to one team: an Apple-anchored
 * chain whose intermediate is the Developer ID CA (…6.2.6) and whose leaf is a
 * Developer ID Application certificate (…6.1.13) for UnlikeOtherAI. A Mac App
 * Store, Apple Development or ad-hoc signature fails it, from any team.
 */
export const UNLIKEOTHERAI_MAC_REQUIREMENT = '=anchor apple generic'
  + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
  + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
  + ` and certificate leaf[subject.OU] = "${UNLIKEOTHERAI_APPLE_TEAM_ID}"`

/** The path travels in the environment, so no quoting can turn it into script. */
const WINDOWS_PATH_VARIABLE = 'NESSIE_PROGRAM_TRUST_PATH'

const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  `$s = Get-AuthenticodeSignature -LiteralPath $env:${WINDOWS_PATH_VARIABLE}`,
  '$subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { "" }',
  '[Console]::Out.Write((@{ status = [string]$s.Status; subject = $subject } | ConvertTo-Json -Compress))',
].join('; ')

const VERIFY_TIMEOUT_MS = 30_000

export type SignatureCommandResult = { code: number | null; stdout: string }

export type SignatureCommandRunner = (
  file: string, args: readonly string[], env: NodeJS.ProcessEnv,
) => Promise<SignatureCommandResult>

const runSignatureCommand: SignatureCommandRunner = (file, args, env) => new Promise((settle) => {
  execFile(file, [...args], { env, timeout: VERIFY_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
    (error, stdout) => {
      const code = error ? typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null : 0
      settle({ code, stdout: String(stdout ?? '') })
    })
})

export type PublisherVerification = {
  platform?: NodeJS.Platform
  run?: SignatureCommandRunner
  /** `%SystemRoot%`, where Windows PowerShell lives; the daemon's own, by default. */
  systemRoot?: string | undefined
}

const verifyMac = async (path: string, run: SignatureCommandRunner): Promise<boolean> => {
  const result = await run('/usr/bin/codesign', ['--verify', '--strict', '-R', UNLIKEOTHERAI_MAC_REQUIREMENT, path],
    { PATH: '/usr/bin:/bin' })
  return result.code === 0
}

/** What a Windows check printed decides, read strictly: anything else is not a signature. */
export const windowsSignatureNamesUnlikeOtherAi = (stdout: string): boolean => {
  try {
    const answer = JSON.parse(stdout) as unknown
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
    const { status, subject } = answer as Record<string, unknown>
    return status === 'Valid' && subject === UNLIKEOTHERAI_WINDOWS_PUBLISHER
  } catch {
    return false
  }
}

const verifyWindows = async (
  path: string, run: SignatureCommandRunner, systemRoot: string | undefined,
): Promise<boolean> => {
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return false
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await run(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
    { SystemRoot: systemRoot, [WINDOWS_PATH_VARIABLE]: path })
  return result.code === 0 && windowsSignatureNamesUnlikeOtherAi(result.stdout.trim())
}

/**
 * The real path of `program` when its verified signature names UnlikeOtherAI,
 * or `undefined`. `program` must already be absolute; a symbolic link is
 * followed once, here, and the answer is the file that was verified.
 */
export const verifiedUnlikeOtherAiProgram = async (
  program: string, options: PublisherVerification = {},
): Promise<string | undefined> => {
  const platform = options.platform ?? process.platform
  if (!programTrustSignatureCovers(platform)) return undefined
  const run = options.run ?? runSignatureCommand
  const file = await realpath(program).catch(() => undefined)
  if (!file || !await stat(file).then((info) => info.isFile(), () => false)) return undefined
  const verified = platform === 'darwin'
    ? await verifyMac(file, run)
    : await verifyWindows(file, run, 'systemRoot' in options ? options.systemRoot : process.env.SystemRoot)
  return verified ? file : undefined
}
