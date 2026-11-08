import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import type { FolderSyncConsoleCommand, FolderSyncConsoleState } from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import type { ExecutorLocalState } from '../state-store.js'
import { loadFolderSyncConfig } from './config.js'
import { readConsoleState, readStatusFile } from './console-state.js'
import { suggestedMainFolder } from './main-folder.js'
import { runConsoleCommand, runVerify, type SyncCommandContext, type SyncConsoleResult } from './sync-command.js'
import { folderSyncPaths } from './state-files.js'
import type { FolderSyncTransport } from './transport.js'
import { listTrash } from './trash-book.js'

/**
 * `nessie-executor sync (--executor <id>|--state-dir <dir>) [--root <path>]
 * [verb] [--json] [--input-stdin]`. Exit codes: 0 done — and always 0 for
 * `--input-stdin`, whose JSON answer says applied, confirm or refused; 1 an
 * error (from the entry point; its last stderr line is what a console shows);
 * 2 a typed verb was refused; 3 `verify` found missing or mismatched files.
 */

export const SYNC_VERBS = [
  'on', 'off', 'pause', 'resume', 'status', 'verify', 'trash', 'resolve', 'confirm-held', 'restore-held',
] as const
export type SyncVerb = (typeof SYNC_VERBS)[number]

export type SyncCliCommand = {
  kind: 'sync'
  executorId?: string
  stateDir?: string
  verb: SyncVerb
  root?: string
  json: boolean
  inputStdin: boolean
  acceptExistingFiles: boolean
  conflictId?: string
  resolution?: 'keep_mine' | 'keep_nessie' | 'dismiss'
  batchId?: string
}

export type SyncCliIo = {
  stdin: Readable
  stdout: Writable
  stateDir: string
  state: ExecutorLocalState
  transport: (state: ExecutorLocalState) => FolderSyncTransport
  home?: string
  /** Windows test runs stand in for the packaged state-security helper. */
  security?: StateSecurityDeps
}

export const SYNC_EXIT = { ok: 0, refused: 2, verifyFailed: 3 } as const

const STDIN_LIMIT = 64 * 1024

const readStdinJson = async (stdin: Readable): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > STDIN_LIMIT) throw new Error('Sync input on standard input is too large.')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Sync input on standard input is not JSON.')
  }
}

const describeState = (state: FolderSyncConsoleState): string => [
  `Folder sync: ${state.state}${state.paused ? ' (paused here)' : ''}`,
  `Folder: ${state.root ?? `not chosen (default ${state.defaultRoot})`}`,
  ...(state.teamFolder ? [`Team folder: ${join(state.root ?? state.defaultRoot, state.teamFolder)}`] : []),
  `Files: ${state.counts.entries} tracked, ${state.counts.pendingUploads} to upload, ${state.counts.pendingDownloads} to download, `
  + `${state.counts.waiting} waiting, ${state.counts.openConflicts} needing you`,
  ...(state.heldDeletes ? [`Held deletions: ${state.heldDeletes.count} (batch ${state.heldDeletes.batchId})`] : []),
  ...state.conflicts.map((row) => `  ${row.reason}: ${row.relPath} (${row.clientConflictId})`),
].join('\n')

const commandFor = async (command: SyncCliCommand, io: SyncCliIo): Promise<FolderSyncConsoleCommand | null> => {
  const config = await loadFolderSyncConfig(io.stateDir)
  const root = command.root ?? config.root ?? await suggestedMainFolder(io.stateDir, io.home ?? homedir())
  switch (command.verb) {
    case 'on': return { command: 'configure', root, enabled: true, acceptExistingFiles: command.acceptExistingFiles }
    case 'off': return { command: 'configure', root, enabled: false, acceptExistingFiles: false }
    case 'pause': return { command: 'pause', paused: true }
    case 'resume': return { command: 'pause', paused: false }
    case 'resolve':
      if (!command.conflictId || !command.resolution) throw new Error('resolve needs --conflict <id> --resolution keep_mine|keep_nessie|dismiss.')
      return { command: 'resolve', clientConflictId: command.conflictId, resolution: command.resolution }
    case 'confirm-held':
    case 'restore-held': {
      const batchId = command.batchId ?? (await readStatusFile(io.stateDir)).heldDeletes?.batchId
      if (!batchId) throw new Error('Nothing is held.')
      return { command: 'held_deletes', batchId, decision: command.verb === 'confirm-held' ? 'confirm' : 'restore' }
    }
    default: return null
  }
}

const printResult = (io: SyncCliIo, json: boolean, result: SyncConsoleResult): number => {
  if (json) io.stdout.write(`${JSON.stringify(result)}\n`)
  else if (result.outcome === 'applied') io.stdout.write(`${describeState(result.state)}\n`)
  else if (result.outcome === 'confirm_existing_files') {
    io.stdout.write(`This folder already has ${result.fileCount} files; they will be added to Nessie. `
      + 'Run again with --accept-existing-files to go ahead.\n')
  } else io.stdout.write(`Refused: ${result.reason}\n`)
  return result.outcome === 'refused' ? SYNC_EXIT.refused : SYNC_EXIT.ok
}

export const runSyncCli = async (command: SyncCliCommand, io: SyncCliIo): Promise<number> => {
  const context: SyncCommandContext = {
    stateDir: io.stateDir, executorId: io.state.executorId, workspaceFolders: io.state.workspaceFolders,
    ...(io.home ? { home: io.home } : {}),
    ...(io.security ? { security: io.security } : {}),
  }
  if (command.inputStdin) {
    // The consoles read the outcome from the JSON; only a real failure exits non-zero.
    const result = await runConsoleCommand(context, await readStdinJson(io.stdin) as FolderSyncConsoleCommand)
    io.stdout.write(`${JSON.stringify(result)}\n`)
    return SYNC_EXIT.ok
  }
  if (command.verb === 'trash') {
    const entries = await listTrash(folderSyncPaths(io.stateDir))
    io.stdout.write(command.json ? `${JSON.stringify({ entries })}\n`
      : `${entries.map((entry) => `${entry.deletedAt}  ${entry.relPath}  (${entry.entryId})`).join('\n') || 'The trash is empty.'}\n`)
    return SYNC_EXIT.ok
  }
  if (command.verb === 'status') {
    const state = await readConsoleState(io.stateDir, io.state.executorId, io.home ?? homedir())
    io.stdout.write(command.json ? `${JSON.stringify(state)}\n` : `${describeState(state)}\n`)
    return SYNC_EXIT.ok
  }
  if (command.verb === 'verify') {
    const report = await runVerify(context, io.transport(io.state))
    const passed = report.missing.length === 0 && report.mismatched.length === 0
    io.stdout.write(command.json ? `${JSON.stringify(report)}\n`
      : `${report.present} of ${report.expected} present; ${report.missing.length} missing, `
        + `${report.mismatched.length} mismatched, ${report.extra.length} extra, ${report.skipped.length} skipped.\n`)
    return passed ? SYNC_EXIT.ok : SYNC_EXIT.verifyFailed
  }
  return printResult(io, command.json, await runConsoleCommand(context, (await commandFor(command, io))!))
}

/** Parse `sync …` (the arguments after the command name). */
export const parseSyncArguments = (args: readonly string[], usage: () => never): SyncCliCommand => {
  const valued = new Set(['--executor', '--state-dir', '--root', '--conflict', '--resolution', '--batch'])
  const flags = new Set(['--json', '--input-stdin', '--accept-existing-files'])
  const values = new Map<string, string>()
  const verbs: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (valued.has(arg)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--') || values.has(arg)) return usage()
      values.set(arg, value)
      index += 1
    } else if (!flags.has(arg)) {
      if (arg.startsWith('--')) return usage()
      verbs.push(arg)
    }
  }
  const inputStdin = args.includes('--input-stdin')
  if (verbs.length > 1 || (inputStdin && verbs.length > 0)) return usage()
  if (!values.has('--executor') && !values.has('--state-dir')) return usage()
  const verb = (verbs[0] ?? 'status') as SyncVerb
  if (!SYNC_VERBS.includes(verb)) return usage()
  const resolution = values.get('--resolution')
  if (resolution !== undefined && !['keep_mine', 'keep_nessie', 'dismiss'].includes(resolution)) return usage()
  return {
    kind: 'sync',
    verb,
    json: args.includes('--json'),
    inputStdin,
    acceptExistingFiles: args.includes('--accept-existing-files'),
    ...(values.has('--executor') ? { executorId: values.get('--executor')! } : {}),
    ...(values.has('--state-dir') ? { stateDir: values.get('--state-dir')! } : {}),
    ...(values.has('--root') ? { root: values.get('--root')! } : {}),
    ...(values.has('--conflict') ? { conflictId: values.get('--conflict')! } : {}),
    ...(resolution ? { resolution: resolution as SyncCliCommand['resolution'] } : {}),
    ...(values.has('--batch') ? { batchId: values.get('--batch')! } : {}),
  }
}
