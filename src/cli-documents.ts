import { resolve } from 'node:path'

import type { FolderSyncConsoleState } from '@nessie/executor-protocol'

import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson } from './cli-output.js'
import type { CliRun } from './cli-user.js'
import { defaultFolderSyncRoot, loadFolderSyncConfig } from './folder-sync/config.js'
import { readConsoleState } from './folder-sync/console-state.js'
import { folderSyncPaths } from './folder-sync/state-files.js'
import { runConsoleCommand, type RestoreTrashCommand, type SyncCommandContext, type SyncConsoleResult } from './folder-sync/sync-command.js'
import { listTrash } from './folder-sync/trash-book.js'
import type { FolderSyncConsoleCommand } from '@nessie/executor-protocol'

/**
 * `documents`: the Documents tab, on the folder sync commands the apps send
 * through `sync --input-stdin` (`runConsoleCommand`) and the readers behind
 * `sync status` and `sync trash`.
 */

const STATE_WORDS: Record<string, string> = {
  off: 'Off', starting: 'Starting…', waiting_for_confirmation: 'Waiting for you to allow it in Nessie', syncing: 'Syncing',
  up_to_date: 'Up to date', paused: 'Paused', root_missing: 'Folder missing — choose it again', disk_full: 'Disk full',
  needs_attention: 'Needs your attention', needs_reauthorization: 'Waiting for you to allow it again in Nessie',
  offline: 'Offline', not_private: 'Not available on a shared computer',
}

/** The Documents tab's sentences for the console refusals. */
const REFUSALS: Record<string, string> = {
  root_not_absolute: 'Choose a folder with its full path.', root_missing: 'That folder no longer exists. Choose another.',
  root_not_a_directory: 'That is a file, not a folder. Choose a folder.',
  root_is_link: 'That folder is a link or shortcut. Choose the real folder.',
  root_not_writable: 'Your account can\'t write to that folder. Choose another.',
  root_overlaps_workspace_folder: 'That folder is inside, or contains, a folder this team\'s agents can read. Choose a separate folder.',
  root_inside_state_directory: 'That folder holds Nessie Computer\'s own files. Choose another.',
  root_inside_other_sync: 'That folder is inside a folder another team syncs on this computer. Choose a separate folder.',
  not_private: 'Documents sync is only for a computer that is yours alone.', conflict_not_found: 'That file is already settled.',
  held_deletes_changed: 'The deletions on hold changed. Check the list again.',
  trash_entry_not_found: 'That file isn\'t in Deleted files any more.',
}

const RESOLUTIONS = { mine: 'keep_mine', nessie: 'keep_nessie', both: 'dismiss' } as const

const describeState = (label: string, state: FolderSyncConsoleState): string => [
  `Documents for ${label}: ${state.enabled ? STATE_WORDS[state.state] ?? state.state : 'Off'}`,
  `Folder: ${state.root ?? `not chosen (suggested ${state.defaultRoot})`}`,
  ...(state.enabled ? [`Files: ${state.counts.entries} kept here, ${state.counts.pendingUploads} to send, `
    + `${state.counts.pendingDownloads} to fetch, ${state.counts.openConflicts} to check`] : []),
  ...(state.heldDeletes ? [`Deletions on hold: ${state.heldDeletes.count}. See nessie-computer documents held.`] : []),
  ...((state.state === 'waiting_for_confirmation' || state.state === 'needs_reauthorization') && state.manageUrl
    ? [`Allow it in Nessie: ${state.manageUrl}`] : []),
].join('\n')

export const runDocuments = async (run: CliRun): Promise<void> => {
  const [action = 'status', ...rest] = operands(run.options, 1, 3, 'documents')
  acceptOnly(run.options, 'documents', action === 'on' ? ['--folder', '--add-existing-files'] : [])
  const team = await run.team()
  const context: SyncCommandContext = { stateDir: team.stateDir, executorId: team.executorId,
    workspaceFolders: team.state.workspaceFolders }
  const current = () => readConsoleState(team.stateDir, team.executorId, run.context.home)
  const none = () => {
    if (rest.length) throw new CliUsageError(`documents ${action} takes nothing after it.`, 'documents')
  }
  const apply = async (command: FolderSyncConsoleCommand | RestoreTrashCommand, done: string): Promise<void> => {
    const result: SyncConsoleResult = await runConsoleCommand(context, command)
    if (result.outcome === 'confirm_existing_files') {
      throw new CliRefusal('DOCUMENTS_FOLDER_HAS_FILES', `This folder already has ${result.fileCount} files. They will be added to `
        + `Nessie for ${team.label}. Run it again with --add-existing-files to go ahead.`)
    }
    if (result.outcome === 'refused') throw new CliRefusal(`DOCUMENTS_${result.reason.toUpperCase()}`, REFUSALS[result.reason] ?? 'Couldn\'t change sync. Try again.')
    if (run.options.json) printJson(run.context, result.state)
    else run.context.out(`${done}\n${describeState(team.label, result.state)}\n`)
  }
  const configure = async (root: string, enabled: boolean, accept: boolean, done: string) => apply(
    { command: 'configure', root: resolve(root), enabled, acceptExistingFiles: accept }, done)
  const config = await loadFolderSyncConfig(team.stateDir)
  switch (action) {
    case 'status': {
      none()
      const state = await current()
      if (run.options.json) printJson(run.context, state)
      else run.context.out(`${describeState(team.label, state)}\n`)
      return
    }
    case 'on':
      none()
      return configure(run.options.values.get('--folder') ?? config.root ?? defaultFolderSyncRoot(run.context.home), true,
        run.options.flags.has('--add-existing-files'), `Documents are on for ${team.label}.`)
    case 'off':
      none()
      return configure(config.root ?? defaultFolderSyncRoot(run.context.home), false, false,
        `Documents are off for ${team.label}. The folder and its files stay on this computer.`)
    case 'folder':
      if (rest.length !== 1) throw new CliUsageError('Give the folder: nessie-computer documents folder <path>.', 'documents')
      return configure(rest[0]!, config.enabled, false, `Documents folder changed for ${team.label}.`)
    case 'pause':
    case 'resume':
      none()
      return apply({ command: 'pause', paused: action === 'pause' },
        action === 'pause' ? `Documents paused for ${team.label}. Nothing is copied until you resume.` : `Documents resumed for ${team.label}.`)
    case 'conflicts': {
      none()
      const conflicts = (await current()).conflicts
      if (run.options.json) printJson(run.context, conflicts)
      else run.context.out(conflicts.length ? `Files to check:\n${columns(conflicts.map((row) => [row.clientConflictId.slice(0, 8),
        row.relPath, row.reason]), '  ')}\nAnswer with nessie-computer documents resolve <id> mine|nessie|both.\n`
        : 'No files to check.\n')
      return
    }
    case 'resolve': {
      const [id, choice] = rest
      const resolution = choice ? RESOLUTIONS[choice as keyof typeof RESOLUTIONS] : undefined
      if (!id || !resolution || rest.length !== 2) throw new CliUsageError('Use documents resolve <id> mine|nessie|both.', 'documents')
      const match = (await current()).conflicts.filter((row) => row.clientConflictId.startsWith(id.toLowerCase()))
      if (match.length !== 1) throw new CliRefusal('DOCUMENTS_CONFLICT_NOT_FOUND', match.length ? `${id} matches more than one file.` : REFUSALS.conflict_not_found!)
      return apply({ command: 'resolve', clientConflictId: match[0]!.clientConflictId, resolution }, `Settled ${match[0]!.relPath}.`)
    }
    case 'deleted': {
      none()
      const entries = await listTrash(folderSyncPaths(team.stateDir))
      if (run.options.json) printJson(run.context, entries)
      else run.context.out(entries.length ? `Deleted files (kept for 30 days):\n${columns(entries.map((entry) => [entry.entryId,
        entry.relPath, entry.deletedAt]), '  ')}\n` : 'Nothing has been deleted in the last 30 days.\n')
      return
    }
    case 'restore':
      if (rest.length !== 1) throw new CliUsageError('Give the id from documents deleted: documents restore <id>.', 'documents')
      return apply({ command: 'restore_trash', entryId: rest[0]! }, `Restored ${rest[0]}.`)
    case 'held': {
      const held = (await current()).heldDeletes
      if (rest.length === 0) {
        if (run.options.json) printJson(run.context, held)
        else run.context.out(held ? `${held.count} files were deleted from the folder at once. They stay in Nessie until you decide:\n`
          + 'nessie-computer documents held restore   brings them back\n'
          + 'nessie-computer documents held delete    deletes them in Nessie too\n' : 'No deletions are on hold.\n')
        return
      }
      const decision = rest[0] === 'restore' ? 'restore' : rest[0] === 'delete' ? 'confirm' : undefined
      if (!decision || rest.length !== 1) throw new CliUsageError('Use documents held restore or documents held delete.', 'documents')
      if (!held) throw new CliRefusal('DOCUMENTS_NOTHING_HELD', 'No deletions are on hold.')
      return apply({ command: 'held_deletes', batchId: held.batchId, decision },
        decision === 'restore' ? 'Restoring the files.' : 'Deleting them in Nessie too.')
    }
    default:
      throw new CliUsageError(`documents has no "${action}". See nessie-computer help documents.`, 'documents')
  }
}
