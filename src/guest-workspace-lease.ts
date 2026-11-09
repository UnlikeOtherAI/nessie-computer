import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, unlink } from 'node:fs/promises'

import { canonicalExecutorJson, RunIdSchema } from '@nessie/executor-protocol'

import { ensureSandboxWorkspace, sandboxFolderPaths } from './sandbox-workspace.js'
import {
  assertExecutorWorkspaceFolderName,
  executorWorkspaceFolderNames,
  type ExecutorWorkspaceFolder,
} from './workspace-folders.js'
import { WorkspacePathError, configureOrdinaryDirectory } from './workspace-paths.js'

type GuestLeaseRecord = {
  bindingFence: string
  commandId: string
  folderName: string
  leaseId: string
  runId: string
  version: 1
}

export type GuestWorkspaceLease = {
  bindingFence: string
  commandId: string
  /** The workspace folder this lease exposes; a guest mounts exactly one. */
  folderName: string
  leaseId: string
  runId: string
  workspace: string
}

/**
 * A guest VM mounts one workspace. Teaching it to mount several is a change to
 * the guest protocol in `executor/guest/*.go` and to the share layout the VM
 * helper builds, which this tranche does not make — so an executor that exposes
 * more than one folder refuses to start a guest session rather than binding to
 * whichever folder happens to be first and letting a person believe an agent
 * inside that VM can see the rest.
 *
 * The refusal is loud on purpose. Silently narrowing an agent's reach is the
 * failure mode worth more than the convenience of a partially working session.
 */
export const guestSessionFolder = (
  folders: readonly ExecutorWorkspaceFolder[],
  overridePath?: string,
): ExecutorWorkspaceFolder => {
  const [only] = folders
  if (!only || folders.length !== 1) {
    throw new WorkspacePathError(
      `A guest session mounts one workspace folder, but this executor exposes ${
        folders.length
      } (${executorWorkspaceFolderNames(folders).join(', ')}). `
      + 'Configure a single folder for guest sessions, or use the workspace file operations, '
      + 'which reach every folder.',
    )
  }
  return overridePath === undefined ? only : { name: only.name, path: overridePath }
}

const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

const parseLease = (value: unknown): GuestLeaseRecord => {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as Record<string, unknown>).bindingFence !== 'string'
    || typeof (value as Record<string, unknown>).commandId !== 'string'
    || typeof (value as Record<string, unknown>).folderName !== 'string'
    || typeof (value as Record<string, unknown>).leaseId !== 'string'
    || typeof (value as Record<string, unknown>).runId !== 'string'
    || (value as Record<string, unknown>).version !== 1
  ) {
    throw new WorkspacePathError('The guest lease is malformed.')
  }
  const record = value as GuestLeaseRecord
  RunIdSchema.parse(record.runId)
  assertExecutorWorkspaceFolderName(record.folderName)
  if (!/^[1-9][0-9]*$/.test(record.bindingFence) || !UUID_PATTERN.test(record.commandId)) {
    throw new WorkspacePathError('The guest lease is malformed.')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.leaseId)) {
    throw new WorkspacePathError('The guest lease is malformed.')
  }
  return record
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const writeLease = async (path: string, record: GuestLeaseRecord): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const value = Buffer.from(canonicalExecutorJson(record), 'utf8')
    let offset = 0
    while (offset < value.byteLength) {
      const result = await handle.write(value, offset, value.byteLength - offset, offset)
      offset += result.bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const readLease = async (path: string): Promise<GuestLeaseRecord> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspacePathError('The guest lease is unavailable.')
  }
  try {
    return parseLease(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error
    throw new WorkspacePathError('The guest lease is malformed.')
  }
}

/**
 * Creates the sole local authority to expose one folder's COW draft to a guest
 * VM. It never accepts a host path to mount: the path is derived after creating
 * the exact server-run COW workspace for that folder. The durable marker
 * prevents a concurrent stop from erasing that draft while a separately spawned
 * VM still has it mounted, and it records which folder is mounted so a release
 * cannot unlock a different one.
 */
export const createGuestWorkspaceLease = async (
  stateDir: string,
  folder: ExecutorWorkspaceFolder,
  input: { bindingFence: string; commandId: string; runId: string },
): Promise<GuestWorkspaceLease> => {
  const parsedRunId = RunIdSchema.parse(input.runId)
  if (!/^[1-9][0-9]*$/.test(input.bindingFence) || !UUID_PATTERN.test(input.commandId)) {
    throw new WorkspacePathError('The guest lease identity is invalid.')
  }
  const workspace = await ensureSandboxWorkspace(stateDir, folder, parsedRunId)
  const paths = await sandboxFolderPaths(stateDir, parsedRunId, folder.name)
  await configureOrdinaryDirectory(paths.root, 'The sandbox')
  const record: GuestLeaseRecord = {
    bindingFence: input.bindingFence,
    commandId: input.commandId,
    folderName: paths.name,
    leaseId: randomUUID(),
    runId: parsedRunId,
    version: 1,
  }
  try {
    await writeLease(paths.guestLease, record)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new WorkspacePathError('The sandbox already has an active guest lease.')
    }
    throw error
  }
  return {
    bindingFence: record.bindingFence,
    commandId: record.commandId,
    folderName: record.folderName,
    leaseId: record.leaseId,
    runId: record.runId,
    workspace,
  }
}

/** Only the holder of the exact durable lease can unblock sandbox teardown. */
export const releaseGuestWorkspaceLease = async (stateDir: string, lease: GuestWorkspaceLease): Promise<void> => {
  const runId = RunIdSchema.parse(lease.runId)
  const paths = await sandboxFolderPaths(stateDir, runId, lease.folderName)
  let stored: GuestLeaseRecord
  try {
    stored = await readLease(paths.guestLease)
  } catch (error) {
    if (missing(error)) throw new WorkspacePathError('The guest lease is unavailable.')
    throw error
  }
  if (
    stored.runId !== runId
    || stored.folderName !== lease.folderName
    || stored.leaseId !== lease.leaseId
    || stored.commandId !== lease.commandId
    || stored.bindingFence !== lease.bindingFence
  ) {
    throw new WorkspacePathError('The guest lease does not match this sandbox.')
  }
  await unlink(paths.guestLease)
}

/**
 * Release this exact lease when it is still present. Guest process cleanup and
 * a caller recovering from a failed start can race here, but neither may
 * remove a newer lease: a missing marker is already clean, while a different
 * marker still fails closed in `releaseGuestWorkspaceLease`.
 */
export const releaseGuestWorkspaceLeaseIfCurrent = async (
  stateDir: string,
  lease: GuestWorkspaceLease,
): Promise<boolean> => {
  try {
    await releaseGuestWorkspaceLease(stateDir, lease)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** Re-read durable state before a VM process receives the COW directory. */
export const assertGuestWorkspaceLeaseCurrent = async (
  stateDir: string,
  lease: GuestWorkspaceLease,
): Promise<void> => {
  const runId = RunIdSchema.parse(lease.runId)
  const paths = await sandboxFolderPaths(stateDir, runId, lease.folderName)
  const stored = await readLease(paths.guestLease)
  if (
    stored.runId !== runId
    || stored.folderName !== lease.folderName
    || stored.leaseId !== lease.leaseId
    || stored.commandId !== lease.commandId
    || stored.bindingFence !== lease.bindingFence
  ) {
    throw new WorkspacePathError('The guest lease does not match this sandbox.')
  }
  const workspace = await configureOrdinaryDirectory(paths.workspace, 'The sandbox workspace')
  if (workspace !== lease.workspace) {
    throw new WorkspacePathError('The guest workspace has changed.')
  }
}
