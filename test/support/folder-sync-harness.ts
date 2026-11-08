import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createExecutorApi } from '../../src/api-client.js'
import { readConsoleState } from '../../src/folder-sync/console-state.js'
import { FolderSyncEngine, type PassOptions, type PassResult } from '../../src/folder-sync/engine.js'
import { runConsoleCommand, type SyncCommandContext } from '../../src/folder-sync/sync-command.js'
import { createFolderSyncTransport, type FolderSyncTransport } from '../../src/folder-sync/transport.js'
import type { StateSecurityDeps } from '../../src/state-security.js'
import { FolderSyncFakeServer } from './folder-sync-fake-server.js'

/**
 * A real temp folder, a real engine and the fake server, wired the way the
 * daemon wires them — the transport signs every call and the fake verifies it.
 * The engine's clock is the harness's, so stability waits are passes, not sleeps.
 */

/** Windows proves owner-only state with the packaged helper; tests stand in for it. */
export const testSecurity: StateSecurityDeps = process.platform === 'win32'
  ? { helper: async (command, path) => { if (command === 'secure-directory') await mkdir(path, { recursive: true }) } }
  : {}

export type SyncHarness = Awaited<ReturnType<typeof createSyncHarness>>

export const createSyncHarness = async (options: {
  spaceName?: string
  /** Wrap the signed transport, to act between a request and its answer. */
  wrap?: (transport: FolderSyncTransport) => FolderSyncTransport
  /** Another team on the same computer: the same home and main folder, its state beside this one's. */
  beside?: { tmp: string }
} = {}) => {
  const server = new FolderSyncFakeServer()
  const space = server.actor.space(options.spaceName ?? 'Projects')
  const tmp = options.beside?.tmp ?? await mkdtemp(join(tmpdir(), 'nessie-sync-'))
  const home = join(tmp, 'home')
  const stateDir = join(tmp, 'state', server.executorId)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await mkdir(home, { recursive: true })
  const root = join(home, 'Documents', 'Nessie')
  let clock = Date.parse('2026-11-03T10:00:00.000Z')
  const api = createExecutorApi({ fetchImpl: server.fetch })
  const signed = createFolderSyncTransport(() => server.connection(), api)
  const transport: FolderSyncTransport = options.wrap ? options.wrap(signed) : signed
  const context: SyncCommandContext = {
    stateDir, executorId: server.executorId, workspaceFolders: [], home, security: testSecurity,
  }
  const newEngine = () => new FolderSyncEngine({
    stateDir, executorId: server.executorId, transport, security: testSecurity,
    now: () => clock, utcOffsetMinutes: () => 0,
  })
  let engine = newEngine()
  // `<Organisation>/<Team>` under the main folder: the fake's names are already clean folder names.
  const teamDir = () => join(root, server.organizationName, server.teamLabel)
  const path = (relPath: string) => join(teamDir(), ...relPath.split('/'))

  const harness = {
    server, space, tmp, home, stateDir, root, transport, context,
    get engine() { return engine },
    get now() { return clock },
    advance: (ms: number) => { clock += ms },
    /** A daemon restart: a fresh engine over the same state directory. */
    restart: () => { engine = newEngine() },
    teamDir, path,
    enable: () => runConsoleCommand(context, { command: 'configure', root, enabled: true, acceptExistingFiles: true }),
    pass: (passOptions: PassOptions = {}): Promise<PassResult> => {
      clock += 3_000
      return engine.runPass({ scope: null, ...passOptions })
    },
    /** Run passes, three seconds apart, until one has nothing more to do. */
    settle: async (maxPasses = 12): Promise<PassResult> => {
      for (let pass = 0; pass < maxPasses; pass += 1) {
        clock += 3_000
        const result = await engine.runPass({ scope: null })
        if (!result.more && result.retryInMs === null) return result
      }
      throw new Error(`Folder sync did not settle in ${maxPasses} passes.`)
    },
    read: (relPath: string) => readFile(path(relPath), 'utf8'),
    readOrNull: (relPath: string) => readFile(path(relPath), 'utf8').catch(() => null),
    write: async (relPath: string, content: string | Uint8Array) => {
      await mkdir(dirname(path(relPath)), { recursive: true })
      await writeFile(path(relPath), content)
    },
    remove: (relPath: string) => rm(path(relPath), { recursive: true, force: true }),
    state: () => readConsoleState(stateDir, server.executorId, home),
    cleanup: () => rm(tmp, { recursive: true, force: true, maxRetries: 3 }),
  }
  return harness
}
