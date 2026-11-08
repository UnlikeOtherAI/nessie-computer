import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  ExecutorCommandEnvelopeSchema,
  ExecutorCommandIdSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { assertOrdinaryDirectory } from './sandbox-layout.js'
import { assertOwnerOnlyStatePath, secureOwnerOnlyStateFile } from './state-security.js'
import { ensureExecutorRuntimeDirectory } from './state-store.js'

/**
 * The daemon's recovery journal: one record per command it holds, from the
 * moment the command arrives until Nessie acknowledges its result. It is local
 * control state, not a second server queue, and lives owner-only beside the
 * machine key as `<runtime>/command-recovery/<commandId>.json`, each record
 * atomically replaced.
 *
 * Phases, in order:
 * - `accepted_pending`: journaled, the `accepted` receipt not yet recorded;
 * - `waiting`: accepted, waiting for a free slot and its resources;
 * - `started_pending`: holding them, the `started` receipt not yet recorded;
 * - `executing`: started — a restart now reports an unknown outcome rather
 *   than run a side effect twice;
 * - `result_pending`: the result, with `delivered` naming the images Nessie
 *   already took, until its receipt is acknowledged.
 *
 * A journal an older daemon left (`command-recovery.json`, one command) is
 * taken over as one record the first time the journal is listed.
 */
export type ExecutorCommandPhase = 'accepted_pending' | 'waiting' | 'started_pending' | 'executing' | 'result_pending'

export type ExecutorCommandRecord = {
  command: ExecutorCommandEnvelope
  delivered?: string[]
  phase: ExecutorCommandPhase
  receivedAt: string
  result?: Record<string, unknown>
  startedAt?: string
  version: 2
}

export type ExecutorCommandJournal = {
  /** Every held command, oldest first. A record this daemon cannot read is set aside and logged. */
  list: () => Promise<ExecutorCommandRecord[]>
  save: (record: ExecutorCommandRecord) => Promise<void>
  remove: (commandId: string) => Promise<void>
}

const JOURNAL_DIRECTORY = 'command-recovery'
const LEGACY_JOURNAL_FILE = 'command-recovery.json'
const PHASES: readonly ExecutorCommandPhase[] = ['accepted_pending', 'waiting', 'started_pending', 'executing', 'result_pending']
const DIGEST = /^sha256:[0-9a-f]{64}$/u

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)
const isDigestList = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((digest) => typeof digest === 'string' && DIGEST.test(digest))
)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** A record, or the version-1 journal an older daemon wrote (which has no `waiting` and no times). */
export const parseExecutorCommandRecord = (
  value: unknown, now: () => Date = () => new Date(),
): ExecutorCommandRecord => {
  const version = isRecord(value) ? value.version : undefined
  if (!isRecord(value) || (version !== 1 && version !== 2)) throw new Error('A command recovery record is malformed.')
  const command = ExecutorCommandEnvelopeSchema.safeParse(value.command)
  const phase = value.phase as ExecutorCommandPhase
  const hasResult = isRecord(value.result) && Object.keys(value.result).length > 0
  if (
    !command.success
    || !PHASES.includes(phase) || (version === 1 && phase === 'waiting')
    || (phase === 'result_pending') !== hasResult
    || (phase !== 'result_pending' && value.delivered !== undefined)
    || (value.delivered !== undefined && !isDigestList(value.delivered))
    || (version === 2 && typeof value.receivedAt !== 'string')
    || (value.startedAt !== undefined && typeof value.startedAt !== 'string')
  ) {
    throw new Error('A command recovery record is malformed.')
  }
  return {
    command: command.data,
    ...(isDigestList(value.delivered) ? { delivered: value.delivered } : {}),
    phase,
    receivedAt: typeof value.receivedAt === 'string' ? value.receivedAt : now().toISOString(),
    ...(hasResult ? { result: value.result as Record<string, unknown> } : {}),
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
    version: 2,
  }
}

export type ExecutorCommandJournalDeps = {
  ensureRuntimeDirectory?: (stateDir: string) => Promise<string>
  log?: (message: string) => void
}

/**
 * One journal secures the runtime directory once, not once per operation: on
 * Windows that proof spawns the packaged native helper twice. Every read and
 * replace still proves the record file itself owner-only before this process
 * trusts its contents.
 */
export const createExecutorCommandJournal = (
  stateDir: string, deps: ExecutorCommandJournalDeps = {},
): ExecutorCommandJournal => {
  const ensureRuntimeDirectory = deps.ensureRuntimeDirectory ?? ensureExecutorRuntimeDirectory
  const log = deps.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  let secured: Promise<string> | undefined
  const runtime = async (): Promise<string> => {
    // A directory that could not be secured once is attempted again next time.
    secured ??= ensureRuntimeDirectory(stateDir)
    try {
      return await secured
    } catch (error) {
      secured = undefined
      throw error
    }
  }
  // Created inside the secured runtime directory, whose DACL it inherits on
  // Windows, and checked once: like the runtime directory, it is setup.
  let journalDirectory: Promise<string> | undefined
  const directory = async (): Promise<string> => {
    journalDirectory ??= runtime().then(async (root) => {
      const path = resolve(root, JOURNAL_DIRECTORY)
      await mkdir(path, { mode: 0o700, recursive: true })
      await assertOrdinaryDirectory(path, 'The command recovery directory is unavailable.')
      return path
    })
    try {
      return await journalDirectory
    } catch (error) {
      journalDirectory = undefined
      throw error
    }
  }
  // A command id is a UUID by schema, which is what makes it a safe file name.
  const recordPath = async (commandId: string): Promise<string> =>
    resolve(await directory(), `${ExecutorCommandIdSchema.parse(commandId)}.json`)

  const write = async (path: string, record: ExecutorCommandRecord): Promise<void> => {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await secureOwnerOnlyStateFile(temporaryPath)
      await rename(temporaryPath, path)
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  const adoptLegacy = async (): Promise<void> => {
    const legacy = resolve(await runtime(), LEGACY_JOURNAL_FILE)
    let value: unknown
    try {
      await assertOwnerOnlyStatePath(legacy, 'file')
      value = JSON.parse(await readFile(legacy, 'utf8'))
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    const record = parseExecutorCommandRecord(value)
    // Written before the old file goes, so a crash between the two leaves the
    // same command in both, which the next start adopts again harmlessly.
    await write(await recordPath(record.command.commandId), record)
    await unlink(legacy)
  }

  return {
    list: async () => {
      await adoptLegacy()
      const root = await directory()
      const records: ExecutorCommandRecord[] = []
      for (const name of await readdir(root)) {
        if (!/^[0-9a-f-]{36}\.json$/u.test(name)) continue
        const path = resolve(root, name)
        try {
          await assertOwnerOnlyStatePath(path, 'file')
          records.push(parseExecutorCommandRecord(JSON.parse(await readFile(path, 'utf8'))))
        } catch (error) {
          if (missing(error)) continue
          // One damaged record must not hold every other command: it is set
          // aside, and Nessie settles that command when it expires.
          log(`command recovery record ${name} was set aside: ${error instanceof Error ? error.message : String(error)}`)
          await rename(path, `${path}.unreadable`).catch(() => undefined)
        }
      }
      return records.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
    },
    save: async (record) => { await write(await recordPath(record.command.commandId), record) },
    remove: async (commandId) => {
      const path = await recordPath(commandId)
      try {
        await assertOwnerOnlyStatePath(path, 'file')
        await unlink(path)
      } catch (error) {
        if (!missing(error)) throw error
      }
    },
  }
}
