import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  FolderSyncConsoleCommandResultSchema,
  FolderSyncConsoleCommandSchema,
  type FolderSyncConsoleCommand,
  type FolderSyncConsoleCommandResult,
  type FolderSyncVerifyReport,
} from '@nessie/executor-protocol'

import { z } from 'zod'

import type { StateSecurityDeps } from '../state-security.js'
import type { ExecutorWorkspaceFolder } from '../workspace-folders.js'
import {
  countExistingFiles,
  loadFolderSyncConfig,
  prepareDefaultRoot,
  readMarker,
  saveFolderSyncConfig,
  syncRootRefusal,
  writeMarker,
} from './config.js'
import { readConsoleState, readStatusFile } from './console-state.js'
import { ConflictBook } from './report.js'
import { ensureFolderSyncDirectories, folderSyncPaths, queueConsoleRequest } from './state-files.js'
import type { FolderSyncTransport } from './transport.js'
import { restoreTrashed } from './trash-book.js'
import { verifyFolderSync } from './verify.js'

/**
 * The machine's side of the Sync tab (plan §5.1–5.2): the console pipes a
 * `FolderSyncConsoleCommand` on stdin — no path or choice ever travels on
 * argv — and reads `FolderSyncConsoleCommandResult` back. The CLI's `sync`
 * verbs are the same commands. Commands only change local files; the daemon's
 * engine carries them out on its next pass.
 */

export type SyncCommandContext = {
  stateDir: string
  executorId: string
  workspaceFolders: readonly ExecutorWorkspaceFolder[]
  home?: string
  security?: StateSecurityDeps
}

const refused = (reason: Extract<FolderSyncConsoleCommandResult, { outcome: 'refused' }>['reason']) =>
  FolderSyncConsoleCommandResultSchema.parse({ outcome: 'refused', reason })

const applied = async (context: SyncCommandContext): Promise<FolderSyncConsoleCommandResult> =>
  FolderSyncConsoleCommandResultSchema.parse({
    outcome: 'applied', state: await readConsoleState(context.stateDir, context.executorId, context.home ?? homedir()),
  })

/**
 * Choose the folder and turn the switch. A folder carrying this executor's
 * marker resumes (C21: it was moved, or chosen again); a fresh one gets a new
 * identity, and when it already holds files the person is asked first (C22).
 */
const configure = async (
  context: SyncCommandContext, command: Extract<FolderSyncConsoleCommand, { command: 'configure' }>,
): Promise<FolderSyncConsoleCommandResult> => {
  const config = await loadFolderSyncConfig(context.stateDir)
  if (!command.enabled) {
    await saveFolderSyncConfig(context.stateDir, { ...config, enabled: false }, context.security)
    return applied(context)
  }
  if (!isAbsolute(command.root)) return refused('root_not_absolute')
  const root = resolve(command.root)
  await prepareDefaultRoot(root, context.home ?? homedir())
  const refusal = await syncRootRefusal(root, {
    workspaceFolders: context.workspaceFolders, stateDir: context.stateDir, executorId: context.executorId,
    ...(context.home ? { home: context.home } : {}),
  })
  if (refusal) return refused(refusal)
  const marker = await readMarker(root, context.executorId)
  let { syncId, teamFolder } = config
  if (marker) {
    syncId = marker.syncId
    teamFolder = marker.teamFolder
  } else {
    const fileCount = await countExistingFiles(root, context.executorId)
    if (fileCount > 0 && !command.acceptExistingFiles) {
      return FolderSyncConsoleCommandResultSchema.parse({ outcome: 'confirm_existing_files', fileCount })
    }
    syncId = randomUUID()
    teamFolder = null
    await writeMarker(root, {
      syncId, executorId: context.executorId, teamFolder: null, createdAt: new Date().toISOString(),
    })
  }
  await saveFolderSyncConfig(context.stateDir, {
    ...config, root, rootRealPath: await realpath(root), enabled: true, syncId, teamFolder,
  }, context.security)
  return applied(context)
}

/**
 * Put a Deleted files entry back (`{ command: 'restore_trash', entryId }`).
 * Not in the shared console command schema: the console sends it and reads the
 * same result shape, and an entry that is gone answers a refusal with the local
 * reason `trash_entry_not_found` (the console shows its generic refusal text).
 */
export const RestoreTrashCommandSchema = z
  .object({ command: z.literal('restore_trash'), entryId: z.string().min(1).max(4096) })
  .strict()
export type RestoreTrashCommand = z.infer<typeof RestoreTrashCommandSchema>
export type SyncConsoleResult = FolderSyncConsoleCommandResult | { outcome: 'refused'; reason: 'trash_entry_not_found' }

export const runConsoleCommand = async (
  context: SyncCommandContext, input: FolderSyncConsoleCommand | RestoreTrashCommand,
): Promise<SyncConsoleResult> => {
  const paths = folderSyncPaths(context.stateDir)
  await ensureFolderSyncDirectories(paths, context.security)
  const restore = RestoreTrashCommandSchema.safeParse(input)
  if (restore.success) {
    const config = await loadFolderSyncConfig(context.stateDir)
    const teamDir = config.root && config.teamFolder ? join(config.root, config.teamFolder) : null
    if (!teamDir || !await restoreTrashed(paths, teamDir, restore.data.entryId)) {
      return { outcome: 'refused', reason: 'trash_entry_not_found' }
    }
    return applied(context)
  }
  const command = FolderSyncConsoleCommandSchema.parse(input)
  if (command.command === 'configure') return configure(context, command)
  if (command.command === 'pause') {
    const config = await loadFolderSyncConfig(context.stateDir)
    await saveFolderSyncConfig(context.stateDir, { ...config, paused: command.paused }, context.security)
    return applied(context)
  }
  if (command.command === 'resolve') {
    const row = (await ConflictBook.open(paths.conflicts)).get(command.clientConflictId)
    if (!row || row.state === 'resolved') return refused('conflict_not_found')
    await queueConsoleRequest(paths, {
      kind: 'resolve', clientConflictId: command.clientConflictId, resolution: command.resolution,
    }, context.security)
    return applied(context)
  }
  const status = await readStatusFile(context.stateDir)
  if (status.heldDeletes?.batchId !== command.batchId) return refused('held_deletes_changed')
  await queueConsoleRequest(paths, { kind: 'held_deletes', batchId: command.batchId, decision: command.decision }, context.security)
  return applied(context)
}

/** `sync verify`: needs the team folder the engine named. */
export const runVerify = async (
  context: SyncCommandContext, transport: FolderSyncTransport,
): Promise<FolderSyncVerifyReport> => {
  const config = await loadFolderSyncConfig(context.stateDir)
  if (!config.root || !config.teamFolder) throw new Error('Folder sync has not started on this computer yet.')
  return verifyFolderSync(transport, join(config.root, config.teamFolder))
}
