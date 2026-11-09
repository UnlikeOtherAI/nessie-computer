import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createExecutorApi } from '../../../src/api-client.js'
import { readConsoleState } from '../../../src/folder-sync/console-state.js'
import { FolderSyncEngine, type PassOptions, type PassResult } from '../../../src/folder-sync/engine.js'
import { runConsoleCommand, type SyncCommandContext } from '../../../src/folder-sync/sync-command.js'
import { createFolderSyncTransport, type FolderSyncTransport } from '../../../src/folder-sync/transport.js'
import type { FolderSyncFakeServer } from '../folder-sync-fake-server.js'
import { testSecurity } from '../folder-sync-harness.js'
import { SimulatedCrash, armRenameCrash, disarmRenameCrash } from './fs-hooks.js'

/**
 * One computer in the simulation: its own folder, state directory, executor
 * identity and engine, a clock that may run a day off (C9), and a transport
 * that lets the simulator act between a request and its answer — another
 * writer racing it, or the computer crashing.
 */

export type TransferHook = (replica: SimReplica, operation: string, pageId: string | null) => Promise<void>

export type PassOutcome =
  | { kind: 'ran'; result: PassResult }
  | { kind: 'failed'; error: unknown }

const TRANSFERS = ['createPage', 'writeDocument', 'uploadFile', 'move', 'archive', 'download'] as const

export class SimReplica {
  engine: FolderSyncEngine
  /** Crash on the `countdown`-th transfer call: before it is sent, or after its answer arrived. */
  transportCrash: { countdown: number; after: boolean } | null = null
  /** Set when a crash fired during the pass now running: the engine is replaced after it. */
  crashed = false
  readonly transport: FolderSyncTransport
  readonly context: SyncCommandContext

  private constructor(
    readonly label: string,
    readonly view: FolderSyncFakeServer,
    readonly tmp: string,
    readonly root: string,
    readonly stateDir: string,
    readonly home: string,
    private readonly clock: () => number,
    readonly skewMs: number,
    hook: TransferHook,
    /** One transfer at a time: the order transfers finish in is then the plan's, not the disk's. */
    private readonly serial: boolean,
  ) {
    const signed = createFolderSyncTransport(() => view.connection(), createExecutorApi({ fetchImpl: view.fetch }))
    this.transport = this.wrap(signed, hook)
    this.context = { stateDir, executorId: view.executorId, workspaceFolders: [], home, security: testSecurity }
    this.engine = this.newEngine()
  }

  static async create(
    label: string, view: FolderSyncFakeServer, clock: () => number, skewMs: number, hook: TransferHook,
    serial = false,
  ): Promise<SimReplica> {
    const tmp = await mkdtemp(join(tmpdir(), `nsim-${label}-`))
    const home = join(tmp, 'home')
    const stateDir = join(tmp, 'state', view.executorId)
    const root = join(home, 'Documents', 'Nessie')
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await mkdir(root, { recursive: true })
    return new SimReplica(label, view, tmp, root, stateDir, home, clock, skewMs, hook, serial)
  }

  now(): number {
    return this.clock() + this.skewMs
  }

  /** The team folder: `<Organisation>/<Team>` under the root (each computer has its own root). */
  teamDir(): string {
    return this.engine.teamDir() ?? join(this.root, this.view.organizationName, this.view.teamLabel)
  }

  private newEngine(): FolderSyncEngine {
    return new FolderSyncEngine({
      stateDir: this.stateDir, executorId: this.view.executorId, transport: this.transport, security: testSecurity,
      now: () => this.now(), computerLabel: this.label, utcOffsetMinutes: () => 0,
      ...(this.serial ? { transferConcurrency: { downloads: 1, uploads: 1 } } : {}),
    })
  }

  /** A crash and a daemon start: a fresh engine over the same state directory. */
  restart(): void {
    this.engine = this.newEngine()
    this.crashed = false
  }

  async enable(): Promise<void> {
    const result = await runConsoleCommand(this.context, {
      command: 'configure', root: this.root, enabled: true, acceptExistingFiles: true,
    })
    if (result.outcome !== 'applied') throw new Error(`${this.label}: sync could not be enabled (${result.outcome}).`)
  }

  /** Arm a crash at a filesystem rename under this computer's folder or state. */
  armRenameCrash(mode: 'before' | 'after', countdown: number): void {
    armRenameCrash(this.tmp, mode, countdown, () => { this.crashed = true })
  }

  async pass(options: PassOptions): Promise<PassOutcome> {
    try {
      return { kind: 'ran', result: await this.engine.runPass(options) }
    } catch (error) {
      return { kind: 'failed', error }
    } finally {
      disarmRenameCrash(this.tmp)
      this.transportCrash = null
      if (this.crashed) this.restart()
    }
  }

  state() {
    return readConsoleState(this.stateDir, this.view.executorId, this.home)
  }

  cleanup(): Promise<void> {
    return rm(this.tmp, { recursive: true, force: true, maxRetries: 3 })
  }

  private wrap(inner: FolderSyncTransport, hook: TransferHook): FolderSyncTransport {
    const around = async <T>(operation: string, pageId: string | null, call: () => Promise<T>): Promise<T> => {
      await hook(this, operation, pageId)
      const crash = this.transportCrash
      if (crash) crash.countdown -= 1
      const fire = crash !== null && crash.countdown <= 0
      if (fire && !crash.after) {
        this.crashed = true
        throw new SimulatedCrash(`before ${operation}`)
      }
      const answer = await call()
      if (fire) {
        this.crashed = true
        throw new SimulatedCrash(`after ${operation}`)
      }
      return answer
    }
    const wrapped: FolderSyncTransport = { ...inner }
    for (const name of TRANSFERS) {
      const original = inner[name] as (...args: unknown[]) => Promise<unknown>
      ;(wrapped as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const first = args[0]
        const pageId = typeof first === 'string' ? first
          : first && typeof first === 'object' && 'pageId' in first && typeof first.pageId === 'string' ? first.pageId
            : first && typeof first === 'object' && 'intent' in first ? pageOfIntent(first.intent) : null
        return around(name, pageId, () => original(...args))
      }
    }
    return wrapped
  }
}

const pageOfIntent = (intent: unknown): string | null =>
  intent && typeof intent === 'object' && 'pageId' in intent && typeof intent.pageId === 'string' ? intent.pageId : null
