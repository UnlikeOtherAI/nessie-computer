import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { WorkspacePathError } from './workspace-paths.js'

/**
 * Firecracker and Hyper-V both implement virtio-block and neither implements
 * virtio-fs, so a share that is a host directory on macOS is a raw ext4 image
 * on every other backend. The images are built **without root**: `mke2fs -d`
 * populates a filesystem from a directory tree in userspace (the same
 * technique Firecracker's own getting-started guide uses to turn its CI
 * rootfs into an ext4 file), so no loop device, no `mount`, and no privileged
 * helper is involved.
 *
 * `-E root_owner=<uid>:<gid>` sets the root directory's owner. That matters:
 * the guest derives the identity it drops to from the owner of `/work`
 * (`executor/guest/identity.go`), and for the block strategy `/work` is an
 * overlay whose attributes come from the draft image's root.
 */
export const GUEST_IMAGE_LABELS = {
  draft: 'nessie-draft',
  runtime: 'nessie-runtime',
  workspace: 'nessie-work',
} as const

/** Every ext4 label is at most 16 bytes; these are checked, not truncated. */
export type GuestImageLabel = (typeof GUEST_IMAGE_LABELS)[keyof typeof GUEST_IMAGE_LABELS]

export const GUEST_IMAGE_BUILD_TIMEOUT_MS = 120_000

/** The draft overlay can never outgrow the COW snapshot it is layered on. */
export const GUEST_DRAFT_IMAGE_BYTES = 128 * 1024 * 1024
export const GUEST_DRAFT_IMAGE_MAX_FILES = 10_000

const MEBIBYTE = 1024 * 1024
const MIN_IMAGE_BYTES = 16 * MEBIBYTE
/** One directory entry plus one tail block of slack for every source file. */
const PER_FILE_SLACK_BYTES = 8 * 1024
const FILESYSTEM_SLACK_BYTES = 16 * MEBIBYTE
const MAX_SOURCE_FILES = 10_000
const MAX_SOURCE_BYTES = 512 * MEBIBYTE

/**
 * `mkfs.ext4` is normally a symbolic link to `mke2fs`, so the check here is
 * executability rather than the non-link rule that guards executor artifacts:
 * this is a distribution tool, not a Nessie-shipped one. A daemon started from
 * systemd has a minimal `PATH` that usually omits `/sbin`, so the candidates
 * are named rather than looked up.
 */
const MKFS_CANDIDATES = ['/sbin/mkfs.ext4', '/usr/sbin/mkfs.ext4', '/bin/mkfs.ext4', '/usr/bin/mkfs.ext4']

export type GuestImageSpawner = (input: {
  argv: string[]
  path: string
  timeoutMs: number
}) => Promise<void>

const runMkfs: GuestImageSpawner = async ({ argv, path, timeoutMs }) => {
  await new Promise<void>((resolvePromise, reject) => {
    // argv is a list, never a shell string: a workspace path can never become
    // an option to the filesystem builder.
    const child = spawn(path, argv, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new WorkspacePathError('Building the executor guest filesystem image timed out.'))
    }, timeoutMs)
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new WorkspacePathError('The executor guest filesystem builder (mkfs.ext4) is unavailable.'))
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise()
      else reject(new WorkspacePathError('The executor guest filesystem image could not be created.'))
    })
  })
}

export const resolveGuestImageBuilder = async (): Promise<string> => {
  for (const candidate of MKFS_CANDIDATES) {
    const usable = await access(candidate, constants.X_OK).then(() => true).catch(() => false)
    if (usable) return candidate
  }
  throw new WorkspacePathError(
    'This computer has no mkfs.ext4, so a sandboxed guest cannot be given its workspace. '
    + 'Install e2fsprogs.',
  )
}

export type GuestImageUsage = { bytes: number; files: number }

/**
 * Measures a source tree the same way the sandbox copy does — no symbolic
 * links, no hard links, no special files — so an image is never sized from a
 * tree the guest could not have been given in the first place.
 */
export const measureGuestImageSource = async (root: string): Promise<GuestImageUsage> => {
  const usage: GuestImageUsage = { bytes: 0, files: 0 }
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError('A guest filesystem image source may not contain symbolic links.')
    }
    if (info.isDirectory()) {
      usage.files += 1
      for (const entry of await readdir(path)) await walk(resolve(path, entry))
      return
    }
    if (!info.isFile()) {
      throw new WorkspacePathError('A guest filesystem image source may not contain special files.')
    }
    usage.files += 1
    usage.bytes += info.size
    if (usage.files > MAX_SOURCE_FILES || usage.bytes > MAX_SOURCE_BYTES) {
      throw new WorkspacePathError('The guest filesystem image source exceeds its size limit.')
    }
  }
  await walk(root)
  return usage
}

/** Whole mebibytes, because `mke2fs` takes a block count and a unit suffix. */
export const guestImageSizeMebibytes = (usage: GuestImageUsage): number => {
  const bytes = usage.bytes + (usage.files * PER_FILE_SLACK_BYTES) + FILESYSTEM_SLACK_BYTES
  return Math.max(Math.ceil(bytes / MEBIBYTE), Math.ceil(MIN_IMAGE_BYTES / MEBIBYTE))
}

export type GuestImageIdentity = { gid: number; uid: number }

/**
 * The guest refuses a root-owned workspace rather than leaving a privileged
 * workload behind (`selectGuestIdentity`), so the refusal is made here, where
 * it can name the remedy, instead of at a boot that only fails.
 */
export const guestImageIdentity = (
  probe: { getgid: () => number | undefined; getuid: () => number | undefined },
): GuestImageIdentity => {
  const uid = probe.getuid()
  const gid = probe.getgid()
  if (uid === undefined || gid === undefined) {
    throw new WorkspacePathError('This platform reports no process uid and gid, so a guest image cannot be built.')
  }
  if (uid === 0 || gid === 0) {
    throw new WorkspacePathError(
      'The executor daemon must not run as root: a guest whose workspace is root-owned refuses to boot rather '
      + 'than leave a privileged workload inside the sandbox. Run the daemon as the account that owns the '
      + 'paired workspace.',
    )
  }
  return { gid, uid }
}

export const buildGuestImageArgv = (input: {
  identity: GuestImageIdentity
  imagePath: string
  inodes: number
  label: GuestImageLabel
  sizeMebibytes: number
  sourceDirectory?: string
}): string[] => [
  '-q',
  // The image is a fresh regular file, so `-F` only silences mke2fs's
  // "not a block device" prompt; it never overwrites a mounted filesystem.
  '-F',
  '-L', input.label,
  '-N', String(input.inodes),
  // No journal and no reserved blocks: the image is session-scoped and is
  // never recovered, so both are pure overhead.
  '-O', '^has_journal',
  '-m', '0',
  '-E', `root_owner=${input.identity.uid}:${input.identity.gid}`,
  ...(input.sourceDirectory ? ['-d', input.sourceDirectory] : []),
  input.imagePath,
  `${input.sizeMebibytes}M`,
]

export type GuestImageDependencies = {
  builderPath?: string
  identity?: GuestImageIdentity
  spawnProcess?: GuestImageSpawner
}

type BuiltImage = { label: GuestImageLabel; path: string; sizeMebibytes: number }

const buildImage = async (
  request: {
    identity: GuestImageIdentity
    imagePath: string
    inodes: number
    label: GuestImageLabel
    sizeMebibytes: number
    sourceDirectory?: string
  },
  builderPath: string,
  spawnProcess: GuestImageSpawner,
): Promise<BuiltImage> => {
  await spawnProcess({
    argv: buildGuestImageArgv(request),
    path: builderPath,
    timeoutMs: GUEST_IMAGE_BUILD_TIMEOUT_MS,
  })
  return { label: request.label, path: request.imagePath, sizeMebibytes: request.sizeMebibytes }
}

export type GuestBlockImages = {
  /** Writable overlay upper+work layer; the only image the guest may change. */
  draft: BuiltImage
  directory: string
  /** Read-only, executable: the verified runtime snapshot. */
  runtime: BuiltImage
  /** Read-only lower layer: the run's copy-on-write workspace snapshot. */
  workspace: BuiltImage
}

/**
 * Builds the three images one session needs, in the exact order the guest
 * expects to find them (see `GUEST_BLOCK_DEVICE_ORDER`). Each also carries its
 * ext4 label so the guest can prove it mounted what the order promised rather
 * than trusting the order alone.
 */
export const buildGuestBlockImages = async (
  input: {
    directory: string
    runtimeSnapshotPath: string
    workspacePath: string
  },
  dependencies: GuestImageDependencies = {},
): Promise<GuestBlockImages> => {
  const builderPath = dependencies.builderPath ?? await resolveGuestImageBuilder()
  const spawnProcess = dependencies.spawnProcess ?? runMkfs
  const identity = dependencies.identity ?? guestImageIdentity({
    getgid: () => process.getgid?.(),
    getuid: () => process.getuid?.(),
  })
  const directory = join(input.directory, 'images')
  await mkdir(directory, { mode: 0o700, recursive: true })
  const [runtimeUsage, workspaceUsage] = await Promise.all([
    measureGuestImageSource(input.runtimeSnapshotPath),
    measureGuestImageSource(input.workspacePath),
  ])
  const runtime = await buildImage({
    identity,
    imagePath: join(directory, 'runtime.img'),
    inodes: runtimeUsage.files + 256,
    label: GUEST_IMAGE_LABELS.runtime,
    sizeMebibytes: guestImageSizeMebibytes(runtimeUsage),
    sourceDirectory: input.runtimeSnapshotPath,
  }, builderPath, spawnProcess)
  const workspace = await buildImage({
    identity,
    imagePath: join(directory, 'workspace.img'),
    inodes: workspaceUsage.files + 256,
    label: GUEST_IMAGE_LABELS.workspace,
    sizeMebibytes: guestImageSizeMebibytes(workspaceUsage),
    sourceDirectory: input.workspacePath,
  }, builderPath, spawnProcess)
  const draft = await buildImage({
    identity,
    imagePath: join(directory, 'draft.img'),
    inodes: GUEST_DRAFT_IMAGE_MAX_FILES + 256,
    label: GUEST_IMAGE_LABELS.draft,
    sizeMebibytes: Math.ceil(GUEST_DRAFT_IMAGE_BYTES / MEBIBYTE),
  }, builderPath, spawnProcess)
  return { directory, draft, runtime, workspace }
}
