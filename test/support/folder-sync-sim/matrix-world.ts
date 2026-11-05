import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { FolderSyncConsoleCommand } from '@nessie/executor-protocol'

import type { PassOptions, PassResult } from '../../../src/folder-sync/engine.js'
import { folderSyncPaths } from '../../../src/folder-sync/state-files.js'
import { runConsoleCommand } from '../../../src/folder-sync/sync-command.js'
import { listTrash } from '../../../src/folder-sync/trash-book.js'
import { SimReplica, type TransferHook } from './replica.js'
import { SimServer } from './sim-server.js'

/**
 * The conflict-matrix tests' world: one Nessie (the simulator's server, so
 * several computers share it and every daemon write is audited) and one or
 * more computers, each a real engine over a real temp folder. Everything is
 * driven by hand: a test writes files, acts in Nessie and settles.
 */

export type Computer = ReturnType<typeof computerOf>

const conflictedCopyMarker = (label: string) => `(conflicted copy – ${label} – `

const computerOf = (replica: SimReplica, advance: (ms: number) => void) => {
  const at = (relPath: string) => join(replica.teamDir(), ...relPath.split('/'))
  const computer = {
    label: replica.label,
    replica,
    get view() { return replica.view },
    path: at,
    read: (relPath: string) => readFile(at(relPath), 'utf8'),
    readOrNull: (relPath: string) => readFile(at(relPath), 'utf8').catch(() => null),
    write: async (relPath: string, content: string | Uint8Array) => {
      await mkdir(dirname(at(relPath)), { recursive: true })
      await writeFile(at(relPath), content)
    },
    remove: (relPath: string) => rm(at(relPath), { recursive: true, force: true }),
    rename: (from: string, to: string) => rename(at(from), at(to)),
    list: (dir: string) => readdir(at(dir)).catch(() => [] as string[]),
    /** The conflicted copies this computer made in `dir`. */
    copies: async (dir: string) => (await readdir(at(dir)).catch(() => [] as string[]))
      .filter((name) => name.includes(conflictedCopyMarker(replica.label))),
    enable: () => replica.enable(),
    command: (command: FolderSyncConsoleCommand) => runConsoleCommand(replica.context, command),
    state: () => replica.state(),
    trash: () => listTrash(folderSyncPaths(replica.stateDir)),
    /** This computer's rows as Nessie holds them. */
    rows: () => [...replica.view.conflicts.values()],
    openRows: () => [...replica.view.conflicts.values()].filter((row) => row.state === 'open'),
    restart: () => replica.restart(),
    /** One pass, three seconds after the last; a failure is returned, not thrown. */
    pass: async (options: PassOptions = { scope: null }) => {
      advance(3_000)
      return replica.pass(options)
    },
    /** Passes until one has nothing more to do; any failed pass throws. */
    settle: async (maxPasses = 16): Promise<PassResult> => {
      for (let n = 0; n < maxPasses; n += 1) {
        const outcome = await computer.pass()
        if (outcome.kind === 'failed') throw outcome.error
        if (!outcome.result.more && outcome.result.retryInMs === null) return outcome.result
        if (outcome.result.retryInMs !== null && outcome.result.retryInMs > 3_000) advance(outcome.result.retryInMs)
      }
      throw new Error(`${replica.label} did not settle in ${maxPasses} passes.`)
    },
  }
  return computer
}

export type MatrixWorld = Awaited<ReturnType<typeof createMatrix>>

export const createMatrix = async (options: {
  computers?: number
  labels?: string[]
  /** Runs between a transfer request and its answer, on every computer. */
  hook?: TransferHook
  /** One computer's clock offset (C9). */
  skewMs?: number[]
} = {}) => {
  const server = new SimServer()
  const space = server.actor.space('Projects')
  let clock = Date.parse('2026-11-03T10:00:00.000Z')
  const advance = (ms: number) => { clock += ms }
  const hook = { current: options.hook ?? (async () => undefined) }
  const count = options.computers ?? 1
  const computers: Computer[] = []
  for (let n = 0; n < count; n += 1) {
    const label = options.labels?.[n] ?? (count === 1 ? 'Laptop' : ['Laptop', 'Desktop', 'Tablet'][n]!)
    const replica = await SimReplica.create(label, server.view(label), () => clock, options.skewMs?.[n] ?? 0,
      (who, operation, pageId) => hook.current(who, operation, pageId))
    computers.push(computerOf(replica, advance))
  }
  const world = {
    server,
    space,
    computers,
    pc: computers[0]!,
    hook,
    advance,
    get now() { return clock },
    /** Turn sync on everywhere and bring every computer to Nessie's state. */
    start: async () => {
      for (const computer of computers) {
        await computer.enable()
        await computer.settle()
      }
    },
    /** Settle every computer, round after round, until a round changes nothing. */
    settleAll: async (rounds = 6) => {
      for (let round = 0; round < rounds; round += 1) {
        const journal = server.journal.length
        for (const computer of computers) await computer.settle()
        if (server.journal.length === journal && round > 0) return
      }
    },
    /** The page at a title path (`Projects/Folder/Title`), as `server.find`. */
    page: (path: string) => server.find(path),
    text: (path: string) => server.text(server.find(path)),
    cleanup: async () => {
      for (const computer of computers) await computer.replica.cleanup()
    },
  }
  return world
}
