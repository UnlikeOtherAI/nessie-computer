import { spawn } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Owner-only private state, proved the way the host proves it.
 *
 * POSIX answers with `uid` and mode bits, which `lstat` reports truthfully.
 * Windows reports neither — every mode comes back `0o666`-shaped and
 * `process.getuid` does not exist — so the same two checks there would either
 * fail closed on every load or pass vacuously. Privacy on Windows is a DACL,
 * and reading one needs Win32, so the state directory is created and verified
 * through the fixed native helper beside the running Node binary.
 *
 * The platform is a parameter rather than a read of `process.platform`, so both
 * arms are exercised from one host and neither can drift untested.
 */

const MODE_MASK_GROUP_OR_OTHER = 0o077

const HELPER_EXECUTABLE = 'nessie-executor-native.exe'

const HELPER_TIMEOUT_MS = 10_000

export type StateSecurityPlatform = NodeJS.Platform

export type StateEntryKind = 'directory' | 'file'

/** What the helper was asked to do and what it answered. */
export type StateSecurityCommand =
  'secure-directory' | 'secure-owner-only-file' | 'verify-owner-only' | 'verify-owner-only-file'

export type StateSecurityHelper = (command: StateSecurityCommand, path: string) => Promise<void>

export type StateSecurityDeps = {
  helper?: StateSecurityHelper
  platform?: StateSecurityPlatform
}

const currentOwnerId = (): number | undefined => process.getuid?.()

/**
 * The helper ships inside the packaged runtime, beside the Node binary running
 * this process. Installed launchers verify that directory against their release
 * manifest. A Windows source-test Node uses the same sibling ACL helper without
 * claiming an installed runtime. Resolving this path grants no release trust,
 * credential custody, update authority or permission to substitute a PATH tool.
 */
export const packagedNativeHelperPath = (): string => join(dirname(process.execPath),
  process.platform === 'win32' ? HELPER_EXECUTABLE : 'nessie-executor-native')

const helperUnavailable = (): Error => new Error(
  'State security on Windows needs the native helper beside its Node runtime. '
  + 'Use the installed package, or the repository Windows test runner with its built native ACL helper.',
)

/** Fixed sibling transport for public ACL operations, independent of installed-runtime admission. */
export const spawnStateSecurityHelper: StateSecurityHelper = async (command, path) => {
  const helperPath = packagedNativeHelperPath()
  const entry = await lstat(helperPath).catch(() => undefined)
  if (!entry?.isFile() || entry.isSymbolicLink()) throw helperUnavailable()
  const answer = await new Promise<string>((settle, fail) => {
    const child = spawn(helperPath, [command, path], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let output = ''
    const timeout = setTimeout(() => {
      child.kill()
      fail(new Error(`State security timed out verifying ${path}.`))
    }, HELPER_TIMEOUT_MS)
    child.once('error', () => {
      clearTimeout(timeout)
      fail(helperUnavailable())
    })
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('close', () => {
      clearTimeout(timeout)
      settle(output)
    })
  })
  assertStateSecurityHelperResponse(answer, path)
}

/** Native path absence has the same typed filesystem contract as Node lstat. */
export const assertStateSecurityHelperResponse = (answer: string, path: string): void => {
  let parsed: { code?: unknown; status?: unknown }
  try {
    parsed = JSON.parse(answer) as { code?: unknown; status?: unknown }
  } catch {
    throw new Error(`State security could not read the helper's answer for ${path}.`)
  }
  if (parsed.status === 'secured' || parsed.status === 'verified') return
  const code = typeof parsed.code === 'string' ? parsed.code : 'EXECUTOR_STATE_SECURITY_REJECTED'
  if (code === 'EXECUTOR_STATE_SECURITY_NOT_FOUND') {
    throw Object.assign(new Error(`State path ${path} no longer exists.`), { code: 'ENOENT' })
  }
  throw new Error(`State path ${path} is not owner-only (${code}).`)
}

const runHelper = async (
  deps: StateSecurityDeps,
  command: StateSecurityCommand,
  path: string,
): Promise<void> => (deps.helper ?? spawnStateSecurityHelper)(command, path)

const platformOf = (deps: StateSecurityDeps): StateSecurityPlatform => deps.platform ?? process.platform

const assertPosixOwnerOnly = async (path: string, expectedKind: StateEntryKind): Promise<void> => {
  const current = await lstat(path)
  const shaped = expectedKind === 'directory' ? current.isDirectory() : current.isFile()
  if (current.isSymbolicLink() || !shaped) {
    throw new Error(`State path ${path} must be an ordinary ${expectedKind}.`)
  }
  if (currentOwnerId() !== undefined && current.uid !== currentOwnerId()) {
    throw new Error(`State path ${path} must be owned by the current user.`)
  }
  if ((current.mode & MODE_MASK_GROUP_OR_OTHER) !== 0) {
    throw new Error(`State path ${path} must not be accessible by other users.`)
  }
}

const assertWindowsShape = async (path: string, expectedKind: StateEntryKind): Promise<void> => {
  const current = await lstat(path)
  const shaped = expectedKind === 'directory' ? current.isDirectory() : current.isFile()
  if (current.isSymbolicLink() || !shaped) {
    throw new Error(`State path ${path} must be an ordinary ${expectedKind}.`)
  }
}

/** Keep Windows private writes owned by the same account across elevation. */
export const secureOwnerOnlyStateFile = async (path: string, deps: StateSecurityDeps = {}): Promise<void> => {
  if (platformOf(deps) !== 'win32') return assertPosixOwnerOnly(path, 'file')
  await assertWindowsShape(path, 'file')
  await runHelper(deps, 'secure-owner-only-file', path)
}

/**
 * Proves a state path is readable only by its owner.
 *
 * Windows checks both the file shape and its own DACL. A caller-selected file
 * may have explicitly overridden its parent directory's inherited DACL, so its
 * parent alone is not a sufficient privacy proof.
 */
export const assertOwnerOnlyStatePath = async (
  path: string,
  expectedKind: StateEntryKind,
  deps: StateSecurityDeps = {},
): Promise<void> => {
  if (platformOf(deps) !== 'win32') {
    await assertPosixOwnerOnly(path, expectedKind)
    return
  }
  await assertWindowsShape(path, expectedKind)
  await runHelper(deps, expectedKind === 'directory' ? 'verify-owner-only' : 'verify-owner-only-file', path)
}

/**
 * Creates the state directory if absent and proves it is owner-only. POSIX
 * carries the answer in the mode it creates with; Windows has the helper apply
 * an explicit, non-inherited DACL and then read it back.
 */
export const ensureOwnerOnlyStateDirectory = async (
  stateDir: string,
  deps: StateSecurityDeps = {},
): Promise<string> => {
  const resolved = resolve(stateDir)
  if (platformOf(deps) !== 'win32') {
    await mkdir(resolved, { mode: 0o700, recursive: true })
    await assertPosixOwnerOnly(resolved, 'directory')
    return resolved
  }
  await runHelper(deps, 'secure-directory', resolved)
  await assertWindowsShape(resolved, 'directory')
  return resolved
}
