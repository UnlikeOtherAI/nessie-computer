import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { readPinnedScriptDigests, verifyPinnedResource } from './hyperv/scripts.js'
import { packagedRuntimeDirectory } from './runtime-integrity.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'
import { ensureExecutorRuntimeDirectory } from './state-store.js'
import type { GuestWorkspaceLease } from './guest-workspace-lease.js'
import { WorkspacePathError } from './workspace-paths.js'

export const GUEST_VM_BUILD_TIMEOUT_MS = 90_000
export const GUEST_VM_HANDSHAKE_TIMEOUT_MS = 45_000
const MAX_CODEX_AUTH_PROFILE_BYTES = 1_048_576

export type GuestVmProcessRunner = (input: {
  argv: string[]
  input: string
  path: string
  timeoutMs: number
}) => Promise<void>

const ownerId = (): number | undefined => process.getuid?.()
const isWindows = (): boolean => process.platform === 'win32'

/**
 * The administrator-installed prefixes. A packaged guest artifact — the kernel,
 * the initrd builder, the runtime, the Firecracker binary — is root-owned by
 * dpkg (`--root-owner-group`, behind an apt repository signature), which is
 * precisely the Linux trust root: only an administrator can produce that state,
 * so a user-writable copy in a home directory can never impersonate it. That is
 * a *different* proof from the owner-private one, not a relaxation of it, so it
 * is admitted only under these prefixes and only for uid 0.
 */
const PACKAGED_ARTIFACT_PREFIXES = ['/usr/lib/', '/usr/share/']

const isPackagedArtifactPath = (canonical: string): boolean =>
  PACKAGED_ARTIFACT_PREFIXES.some((prefix) => canonical.startsWith(prefix))

const verifyWindowsPackagedArtifact = async (canonical: string): Promise<string> => {
  const resourcesDirectory = join(packagedRuntimeDirectory(), 'resources')
  const verified = await verifyPinnedResource({
    path: canonical,
    resourcesDirectory,
    digests: await readPinnedScriptDigests(resourcesDirectory),
  })
  return verified
}

const verifyOwnerPrivateFile = async (
  value: string,
  options: {
    allowPackagedRoot?: boolean
    executable: boolean
    expectedModes?: number[]
    label: string
    maxBytes?: number
    requireNonEmpty?: boolean
    singleLink?: boolean
  },
): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError(`The executor ${options.label} path must be absolute.`)
  const declared = resolve(value)
  const initial = await lstat(declared)
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new WorkspacePathError(`The executor ${options.label} must be an ordinary file.`)
  }
  const canonical = await realpath(declared)
  const info = await lstat(canonical)
  if (isWindows()) {
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new WorkspacePathError(`The executor ${options.label} must be an ordinary file.`)
    }
    if (options.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new WorkspacePathError(`The executor ${options.label} must be owner-private and non-symbolic.`)
    }
    if ((options.requireNonEmpty && info.size === 0) || (options.singleLink && info.nlink !== 1)) {
      throw new WorkspacePathError(`The executor ${options.label} must be owner-private and non-symbolic.`)
    }
    if (options.allowPackagedRoot) return verifyWindowsPackagedArtifact(canonical)
    await assertOwnerOnlyStatePath(canonical, 'file').catch(() => {
      throw new WorkspacePathError(`The executor ${options.label} must be owner-private and non-symbolic.`)
    })
    return canonical
  }
  // Two admissible provenances, never a blend: this account's own private file,
  // or an administrator-installed root-owned one under a packaged prefix. Both
  // forbid group and world *write*; the packaged one is deliberately readable,
  // because the daemon runs as an ordinary account.
  const ownedPrivately = ownerId() === undefined || info.uid === ownerId()
  const ownedByPackage = Boolean(options.allowPackagedRoot)
    && info.uid === 0
    && isPackagedArtifactPath(canonical)
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || (!ownedPrivately && !ownedByPackage)
    || (info.mode & 0o022) !== 0
    || (!ownedByPackage && (info.mode & 0o077) !== 0)
    || (options.executable && (info.mode & constants.S_IXUSR) === 0)
    || (options.expectedModes !== undefined && !options.expectedModes.includes(info.mode & 0o777))
    || (options.maxBytes !== undefined && info.size > options.maxBytes)
    || (options.requireNonEmpty && info.size === 0)
    || (options.singleLink && info.nlink !== 1)
  ) {
    throw new WorkspacePathError(`The executor ${options.label} must be owner-private and non-symbolic.`)
  }
  return canonical
}

export const verifyPrivateGuestVmFile = async (value: string, executable: boolean): Promise<string> =>
  verifyOwnerPrivateFile(value, { allowPackagedRoot: true, executable, label: 'VM artifact' })

/** A login profile is copied by the owner-controlled initrd builder, never read by Nessie. */
export const verifyPrivateCodexAuthProfile = async (value: string): Promise<string> =>
  verifyOwnerPrivateFile(value, {
    executable: false,
    expectedModes: [0o400, 0o600],
    label: 'Codex auth profile',
    maxBytes: MAX_CODEX_AUTH_PROFILE_BYTES,
    requireNonEmpty: true,
    singleLink: true,
  })

export const runGuestVmProcess: GuestVmProcessRunner = async ({ argv, input, path, timeoutMs }) => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(path, argv, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new WorkspacePathError('The executor VM helper timed out.'))
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new WorkspacePathError('The executor VM helper is unavailable.'))
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise()
      else reject(new WorkspacePathError('The executor VM helper rejected the guest.'))
    })
    child.stdin?.end(input)
  })
}

export const secureGuestVmSessionDirectory = async (
  stateDir: string,
  lease: GuestWorkspaceLease,
): Promise<string> => {
  const runtime = await ensureExecutorRuntimeDirectory(stateDir)
  const parent = join(runtime, 'guest-vms')
  if (isWindows()) await ensureOwnerOnlyStateDirectory(parent)
  else await mkdir(parent, { mode: 0o700, recursive: true })
  const info = await lstat(parent)
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || (!isWindows() && ((ownerId() !== undefined && info.uid !== ownerId()) || (info.mode & 0o077) !== 0))
  ) {
    throw new WorkspacePathError('The executor VM runtime directory is unavailable.')
  }
  const directory = await mkdtemp(join(parent, `${basename(lease.leaseId)}-`))
  if (isWindows()) await ensureOwnerOnlyStateDirectory(directory)
  else await chmod(directory, 0o700)
  return directory
}

/**
 * An owner-private ephemeral directory shallow enough to hold a Unix socket.
 * `sun_path` is 104 bytes on macOS and 108 on Linux, and the executor's own
 * state root — `~/.local/state/nessie-executor/<id>/runtime/guest-vms/<lease>`
 * — already spends most of that, so any transport socket gets its own short
 * root instead of a deeper path that binds fine in a test and fails in a home
 * directory. `longestChild` is the longest path that will ever hang below it,
 * checked here rather than at each `listen`.
 */
const secureShortSocketDirectory = async (
  prefix: string,
  longestChild: string,
  label: string,
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    await chmod(directory, 0o700)
    const info = await lstat(directory)
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || (ownerId() !== undefined && info.uid !== ownerId())
      || (info.mode & 0o077) !== 0
      || join(directory, longestChild).length > 96
    ) {
      throw new WorkspacePathError(`The executor ${label} directory is unavailable.`)
    }
    return directory
  } catch (error) {
    await rm(directory, { force: true, recursive: true })
    throw error
  }
}

export const secureGuestVmGatewayDirectory = (): Promise<string> =>
  secureShortSocketDirectory('nex-egress-', 'egress.sock', 'egress socket')

/**
 * Firecracker binds its REST API socket and its vsock device here, and each
 * guest-initiated vsock port adds a `_<port>` suffix to the latter, so the
 * longest child is the egress channel's listener. There is no jailer and hence
 * no chroot: this owner-only directory *is* the session's socket root.
 */
export const secureFirecrackerSocketDirectory = (): Promise<string> =>
  secureShortSocketDirectory('nex-fc-', 'v.sock_49153', 'micro-VM socket')
