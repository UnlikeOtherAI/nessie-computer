import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { WorkspacePathError } from '../workspace-paths.js'

/**
 * The four PowerShell scripts that own a guest VM's whole life. They are
 * *pinned*: each ships in the installer, root-owned under Program Files, and
 * its SHA-256 is recorded in the package's own `resources/manifest.json`. The
 * backend refuses to run one whose bytes differ, so a person who can write into
 * Program Files still cannot turn `create.ps1` into something else the daemon
 * will run as itself.
 *
 * Nothing is ever composed into a command string. Every invocation is
 * `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
 * <script> -Param <value> …` as an argv array, and with `-File` PowerShell
 * binds the remaining arguments to the script's own parameters instead of
 * parsing them as expressions — so a workspace path can never become code.
 */
export const HYPERV_SCRIPTS = ['create.ps1', 'remove.ps1', 'start.ps1', 'stop.ps1'] as const

export type HyperVScriptName = (typeof HYPERV_SCRIPTS)[number]

/** Where the installer lays the scripts down, relative to the resource root. */
export const HYPERV_SCRIPT_DIRECTORY = 'scripts'

export const SHA256_HEX = /^[0-9a-f]{64}$/

export type PinnedScriptDigests = Readonly<Record<string, string>>

/**
 * Reads the digests out of the package manifest the installer wrote. The
 * manifest lists every shipped resource by its path relative to the resource
 * root, which is the same shape the Linux package writes, so one integrity
 * check covers the scripts, the kernel, the initrd builder and the bridge.
 */
export const readPinnedScriptDigests = async (
  resourcesDirectory: string,
): Promise<PinnedScriptDigests> => {
  const raw = await readFile(join(resourcesDirectory, 'manifest.json'), 'utf8').catch(() => undefined)
  if (raw === undefined) {
    throw new WorkspacePathError('The executor guest VM resources are not installed on this computer.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new WorkspacePathError('The executor guest VM resource manifest is unreadable.')
  }
  const files = (parsed as { files?: unknown }).files
  if (!Array.isArray(files)) {
    throw new WorkspacePathError('The executor guest VM resource manifest is unreadable.')
  }
  const digests: Record<string, string> = {}
  for (const entry of files) {
    const path = (entry as { path?: unknown }).path
    const sha256 = (entry as { sha256?: unknown }).sha256
    if (typeof path === 'string' && typeof sha256 === 'string' && SHA256_HEX.test(sha256)) {
      // The manifest is written on Windows, so its separators are backslashes.
      digests[path.replace(/\\/g, '/')] = sha256
    }
  }
  return digests
}

/**
 * Proves an installed resource is the exact byte sequence declared by the
 * package manifest. This is the Windows provenance for immutable files under
 * Program Files: they are package-owned and readable by the service, rather
 * than owner-private state files.
 */
export const verifyPinnedResource = async (input: {
  path: string
  resourcesDirectory: string
  digests: PinnedScriptDigests
}): Promise<string> => {
  const resourcesRoot = resolve(input.resourcesDirectory)
  const candidate = resolve(input.path)
  const resourcePath = relative(resourcesRoot, candidate).split(sep).join('/')
  if (isAbsolute(resourcePath) || resourcePath === '' || resourcePath === '..' || resourcePath.startsWith('../')) {
    throw new WorkspacePathError('The executor VM artifact is not a packaged resource.')
  }
  const expected = input.digests[resourcePath]
  if (expected === undefined) {
    throw new WorkspacePathError('The executor VM artifact is not pinned by the installed package.')
  }
  const bytes = await readFile(candidate).catch(() => undefined)
  if (bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new WorkspacePathError('The executor VM artifact does not match the installed package.')
  }
  return candidate
}

export type PinnedScriptStore = {
  /** Absolute path of a script whose bytes match its pinned digest. */
  resolve: (name: HyperVScriptName) => Promise<string>
}

export const createPinnedScriptStore = (input: {
  digests: PinnedScriptDigests
  resourcesDirectory: string
}): PinnedScriptStore => ({
  resolve: async (name) => {
    const relative = `${HYPERV_SCRIPT_DIRECTORY}/${name}`
    const expected = input.digests[relative]
    if (expected === undefined) {
      throw new WorkspacePathError(`The executor guest VM script ${name} is not a pinned resource.`)
    }
    const path = join(input.resourcesDirectory, HYPERV_SCRIPT_DIRECTORY, name)
    const bytes = await readFile(path).catch(() => undefined)
    if (bytes === undefined) {
      throw new WorkspacePathError(`The executor guest VM script ${name} is not installed.`)
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new WorkspacePathError(
        `The executor guest VM script ${name} does not match the signed package. `
        + 'Reinstall Nessie Executor.',
      )
    }
    return path
  },
})

/** A script parameter name is a fixed identifier, never caller-supplied text. */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/

export type PowerShellParameters = ReadonlyArray<readonly [string, string]>

/**
 * `-NoProfile` so nothing a person put in their profile runs, `-NonInteractive`
 * so a prompt can never hang a session forever, and `-ExecutionPolicy Bypass`
 * because execution policy is a user-convenience setting rather than a security
 * boundary and the integrity of these scripts is proven by their digest instead.
 */
export const powerShellArgv = (
  scriptPath: string,
  parameters: PowerShellParameters,
): string[] => {
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
  for (const [name, value] of parameters) {
    if (!PARAMETER_NAME.test(name)) {
      throw new WorkspacePathError('An executor guest VM script parameter name is invalid.')
    }
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      throw new WorkspacePathError('An executor guest VM script parameter value is invalid.')
    }
    argv.push(`-${name}`, value)
  }
  return argv
}
