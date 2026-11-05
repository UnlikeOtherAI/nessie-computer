import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'
import { WorkspacePathError } from './workspace-paths.js'

const MANIFEST_FILE = 'nessie-guest-runtime.json'
const MAX_MANIFEST_BYTES = 1_048_576
const MAX_RUNTIME_FILES = 4_096
const SHA256 = /^[a-f0-9]{64}$/
const COPY_BUFFER_SIZE = 64 * 1_024

type GuestRuntimeManifestFile = {
  executable: boolean
  path: string
  sha256: string
}

export type VerifiedGuestRuntimeBundle = {
  entrypoints: {
    browser?: string
    claude?: string
    codex?: string
    tmux?: string
  }
  manifestDigest: string
  root: string
}

const ownerId = (): number | undefined => process.getuid?.()
const isWindows = (): boolean => process.platform === 'win32'

const invalid = (message: string): never => {
  throw new WorkspacePathError(`The guest runtime bundle ${message}.`)
}

const relativeFilePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\\')) {
    return invalid('contains an invalid file path')
  }
  const pieces = value.split('/')
  if (pieces.some((piece) => piece.length === 0 || piece === '.' || piece === '..')) {
    return invalid('contains an invalid file path')
  }
  return value
}

const readOwnerPrivateFile = async (path: string, maxBytes?: number): Promise<Buffer> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => invalid('file is unavailable'))
  try {
    const info = await file.stat()
    if (
      !info.isFile()
      || info.nlink !== 1
      || (!isWindows() && ((ownerId() !== undefined && info.uid !== ownerId()) || (info.mode & 0o077) !== 0))
      || (maxBytes !== undefined && info.size > maxBytes)
    ) {
      invalid('file must be owner-private and non-symbolic')
    }
    if (isWindows()) await assertOwnerOnlyStatePath(path, 'file').catch(() => invalid('file must be owner-private and non-symbolic'))
    return await file.readFile()
  } finally {
    await file.close()
  }
}

const writeComplete = async (file: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> => {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset)
    if (bytesWritten === 0) invalid('snapshot write failed')
    offset += bytesWritten
  }
}

const copyRuntimeFile = async (
  source: string,
  destination: string,
  definition: GuestRuntimeManifestFile,
): Promise<void> => {
  const sourceFile = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => invalid('file is unavailable'))
  let destinationFile: Awaited<ReturnType<typeof open>> | undefined
  try {
    const info = await sourceFile.stat()
    if (
      !info.isFile()
      || info.nlink !== 1
      || (!isWindows() && (
        (ownerId() !== undefined && info.uid !== ownerId())
        || (info.mode & 0o077) !== 0
        || (definition.executable && (info.mode & constants.S_IXUSR) === 0)
        || (!definition.executable && (info.mode & constants.S_IXUSR) !== 0)
      ))
    ) {
      invalid('file integrity check failed')
    }
    if (isWindows()) await assertOwnerOnlyStatePath(source, 'file').catch(() => invalid('file integrity check failed'))
    destinationFile = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      definition.executable ? 0o500 : 0o400,
    )
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE)
    let position = 0
    for (;;) {
      const { bytesRead } = await sourceFile.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await writeComplete(destinationFile, chunk)
      position += bytesRead
    }
    if (hash.digest('hex') !== definition.sha256) invalid('file integrity check failed')
    await destinationFile.sync()
  } finally {
    await destinationFile?.close()
    await sourceFile.close()
  }
}

const fileDigest = async (path: string, definition: GuestRuntimeManifestFile): Promise<string> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => invalid('file is unavailable'))
  try {
    const info = await file.stat()
    if (
      !info.isFile()
      || info.nlink !== 1
      || (!isWindows() && (
        (ownerId() !== undefined && info.uid !== ownerId())
        || (info.mode & 0o077) !== 0
        || (definition.executable && (info.mode & constants.S_IXUSR) === 0)
        || (!definition.executable && (info.mode & constants.S_IXUSR) !== 0)
      ))
    ) {
      invalid('file integrity check failed')
    }
    if (isWindows()) await assertOwnerOnlyStatePath(path, 'file').catch(() => invalid('file integrity check failed'))
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE)
    let position = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

const assertOwnerPrivateDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || (!isWindows() && ((ownerId() !== undefined && info.uid !== ownerId()) || (info.mode & 0o077) !== 0))
  ) {
    invalid('directory must be owner-private and non-symbolic')
  }
  if (isWindows()) await assertOwnerOnlyStatePath(path, 'directory').catch(() => invalid('directory must be owner-private and non-symbolic'))
}

const parseManifest = (value: unknown): {
  entrypoints: VerifiedGuestRuntimeBundle['entrypoints']
  files: GuestRuntimeManifestFile[]
} => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('manifest is malformed')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1
    || !Array.isArray(record.files)
    || record.files.length === 0
    || record.files.length > MAX_RUNTIME_FILES
  ) {
    invalid('manifest is malformed')
  }
  const rawFiles = record.files as unknown[]
  const files = rawFiles.map((raw): GuestRuntimeManifestFile => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('manifest is malformed')
    const file = raw as Record<string, unknown>
    const executable = file.executable
    const sha256 = file.sha256
    if (typeof executable !== 'boolean' || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      invalid('manifest is malformed')
    }
    return {
      executable: executable as boolean,
      path: relativeFilePath(file.path),
      sha256: sha256 as string,
    }
  })
  if (new Set(files.map((file) => file.path)).size !== files.length) invalid('manifest repeats a file')

  const rawEntrypoints = record.entrypoints
  if (!rawEntrypoints || typeof rawEntrypoints !== 'object' || Array.isArray(rawEntrypoints)) {
    invalid('manifest is malformed')
  }
  const entrypointRecord = rawEntrypoints as Record<string, unknown>
  const entrypoints: VerifiedGuestRuntimeBundle['entrypoints'] = {}
  const entrypointNames = ['browser', 'tmux', 'codex', 'claude'] as const
  if (Object.keys(entrypointRecord).some((name) => !entrypointNames.includes(name as typeof entrypointNames[number]))) {
    invalid('manifest is malformed')
  }
  for (const name of entrypointNames) {
    const candidate = entrypointRecord[name]
    if (candidate === undefined) continue
    entrypoints[name] = relativeFilePath(candidate)
  }
  if (!entrypoints.browser && !entrypoints.tmux) invalid('does not declare a browser or tmux entrypoint')
  const executableFiles = new Set(files.filter((file) => file.executable).map((file) => file.path))
  if (Object.values(entrypoints).some((path) => path && !executableFiles.has(path))) {
    invalid('entrypoint is not a declared executable')
  }
  return { entrypoints, files }
}

const walkBundle = async (root: string, directory = root): Promise<string[]> => {
  await assertOwnerPrivateDirectory(directory)
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkBundle(root, path))
      continue
    }
    const rel = relative(root, path).split(sep).join('/')
    if (!entry.isFile() || entry.isSymbolicLink()) invalid('contains a non-regular file')
    files.push(rel)
  }
  return files
}

const createSnapshotDirectory = async (root: string, relativePath: string): Promise<void> => {
  let current = root
  for (const piece of dirname(relativePath).split('/')) {
    if (piece === '.') continue
    current = resolve(current, piece)
    if (isWindows()) await ensureOwnerOnlyStateDirectory(current)
    else await mkdir(current, { mode: 0o700, recursive: true })
    await assertOwnerPrivateDirectory(current)
  }
}

const writeSnapshotManifest = async (path: string, contents: Buffer): Promise<void> => {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  )
  try {
    await writeComplete(file, contents)
    await file.sync()
  } finally {
    await file.close()
  }
}

const lockSnapshotDirectories = async (root: string, directory = root): Promise<void> => {
  if (isWindows()) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await lockSnapshotDirectories(root, resolve(directory, entry.name))
  }
  await chmod(directory, 0o500)
}

const unlockSnapshotDirectories = async (directory: string): Promise<void> => {
  if (isWindows()) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockSnapshotDirectories(resolve(directory, entry.name))
  }
  await chmod(directory, 0o700)
}

/**
 * Verifies a complete, owner-private runtime payload. The verified root is an
 * artifact reference only: it is never executed on the host and a session must
 * still mount a separately packaged guest image before an operation is exposed.
 */
export const verifyGuestRuntimeBundle = async (rawRoot: string): Promise<VerifiedGuestRuntimeBundle> => {
  if (!isAbsolute(rawRoot)) invalid('path must be absolute')
  const root = resolve(rawRoot)
  await assertOwnerPrivateDirectory(root)
  const manifestPath = resolve(root, MANIFEST_FILE)
  const manifestInfo = await lstat(manifestPath).catch(() => invalid('manifest is missing'))
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (!isWindows() && (manifestInfo.mode & 0o077) !== 0)) {
    invalid('manifest must be owner-private and non-symbolic')
  }
  const manifestBytes = await readOwnerPrivateFile(manifestPath, MAX_MANIFEST_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    invalid('manifest is malformed')
  }
  const manifest = parseManifest(parsed)
  const declared = new Map(manifest.files.map((file) => [file.path, file]))
  const actualFiles = await walkBundle(root)
  const runtimeFiles = actualFiles.filter((path) => path !== MANIFEST_FILE)
  if (runtimeFiles.length !== declared.size || runtimeFiles.some((path) => !declared.has(path))) {
    invalid('does not match its declared file set')
  }
  for (const [path, file] of declared) {
    const absolute = resolve(root, path)
    if (!absolute.startsWith(`${root}${sep}`)) invalid('contains an invalid file path')
    const info = await lstat(absolute)
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.nlink !== 1
      || (!isWindows() && (
        (ownerId() !== undefined && info.uid !== ownerId())
        || (info.mode & 0o077) !== 0
        || (file.executable && (info.mode & constants.S_IXUSR) === 0)
        || (!file.executable && (info.mode & constants.S_IXUSR) !== 0)
      ))
      || await fileDigest(absolute, file) !== file.sha256
    ) {
      invalid('file integrity check failed')
    }
  }
  return {
    entrypoints: manifest.entrypoints,
    manifestDigest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
    root,
  }
}

/**
 * Copies a previously verified bundle into an owner-private lease directory.
 * The copy is bound to the exact manifest digest already authorized for this
 * session, so later source-bundle edits cannot alter what the guest mounts.
 */
export const materializeGuestRuntimeBundle = async (
  bundle: VerifiedGuestRuntimeBundle,
  rawDestination: string,
): Promise<VerifiedGuestRuntimeBundle> => {
  if (!isAbsolute(rawDestination)) invalid('snapshot path must be absolute')
  const destination = resolve(rawDestination)
  if (destination === bundle.root) invalid('snapshot path must differ from its source')
  await assertOwnerPrivateDirectory(dirname(destination))
  if (isWindows()) await ensureOwnerOnlyStateDirectory(destination)
  else await mkdir(destination, { mode: 0o700 })
  try {
    const manifestPath = resolve(bundle.root, MANIFEST_FILE)
    const manifestBytes = await readOwnerPrivateFile(manifestPath, MAX_MANIFEST_BYTES)
    const manifestDigest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`
    if (manifestDigest !== bundle.manifestDigest) invalid('changed after verification')
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestBytes.toString('utf8'))
    } catch {
      invalid('manifest is malformed')
    }
    const manifest = parseManifest(parsed)
    for (const file of manifest.files) {
      await createSnapshotDirectory(destination, file.path)
      await copyRuntimeFile(resolve(bundle.root, file.path), resolve(destination, file.path), file)
    }
    await writeSnapshotManifest(resolve(destination, MANIFEST_FILE), manifestBytes)
    const snapshot = await verifyGuestRuntimeBundle(destination)
    if (snapshot.manifestDigest !== bundle.manifestDigest) invalid('snapshot integrity check failed')
    await lockSnapshotDirectories(destination)
    return snapshot
  } catch (error) {
    await removeGuestRuntimeBundleSnapshot(destination)
    throw error
  }
}

/** Removes a session-owned snapshot after restoring its private directory modes. */
export const removeGuestRuntimeBundleSnapshot = async (rawPath: string): Promise<void> => {
  if (!isAbsolute(rawPath)) invalid('snapshot path must be absolute')
  const path = resolve(rawPath)
  await unlockSnapshotDirectories(path).catch(() => undefined)
  await rm(path, { force: true, recursive: true })
}
