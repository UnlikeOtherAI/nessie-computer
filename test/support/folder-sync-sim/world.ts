import type { PassOptions } from '../../../src/folder-sync/engine.js'
import { mapTree } from '../../../src/folder-sync/path-mapping.js'
import { runConsoleCommand } from '../../../src/folder-sync/sync-command.js'
import { actorCreate, actorEdit, actorOperation } from './actor-ops.js'
import { SimulatedCrash } from './fs-hooks.js'
import { ContentLedger, editedText, listTree, personOperation, personWrite, type PersonContext } from './local-ops.js'
import { Prng } from './prng.js'
import { SimReplica } from './replica.js'
import { SimServer } from './sim-server.js'

/**
 * One simulated world: Nessie, two or three computers and the people and
 * agents around them, driven by one seed. `step` does one random thing;
 * `quiesce` brings everyone back online and runs every computer until nothing
 * is left to do; the oracles then judge what is left.
 */

export type WorldOptions = { replicas: number; seedPages: number; skew: boolean; serial?: boolean }

const DAY_MS = 24 * 60 * 60 * 1000
const FAULT_OPERATIONS = [
  'write_document', 'upload_complete', 'upload_begin', 'upload_part', 'create_page', 'move', 'archive', 'download',
  'changes', 'snapshot', 'report',
]

export class SimWorld {
  readonly rng: Prng
  readonly server = new SimServer()
  readonly replicas: SimReplica[] = []
  readonly ledger = new ContentLedger()
  readonly trace: string[] = []
  /** Failures the run itself saw (a pass that threw something unexpected, a stuck quiescence). */
  readonly problems: string[] = []
  readonly person: PersonContext
  clock = Date.parse('2026-11-03T10:00:00.000Z')
  interference = true
  private tokens = 0
  private nesting = 0

  constructor(readonly seed: number) {
    this.rng = new Prng(seed)
    this.person = {
      rng: this.rng, ledger: this.ledger, token: () => `s${seed}-t${(this.tokens += 1)}`,
      log: (message) => this.log(message),
    }
  }

  log(message: string): void {
    this.trace.push(message)
  }

  /** Make `globalThis.simLog` write to this world's trace (a debugging aid for one replayed seed). */
  attachDebugLog(): void {
    (globalThis as { simLog?: (message: string) => void }).simLog = (message) => this.log(message)
  }

  async setUp(options: WorldOptions): Promise<void> {
    this.server.actor.space('Projects')
    if (this.rng.chance(0.3)) this.server.actor.space('Shared')
    for (let n = 0; n < options.seedPages; n += 1) actorCreate(this.person, this.server, 'seed')
    const skewed = options.skew ? this.rng.int(options.replicas) : -1
    for (let n = 0; n < options.replicas; n += 1) {
      const skewMs = n === skewed ? (this.rng.chance(0.5) ? DAY_MS : -DAY_MS) : 0
      const label = `PC${n + 1}`
      const replica = await SimReplica.create(label, this.server.view(label), () => this.clock, skewMs,
        (who, operation, pageId) => this.duringTransfer(who, operation, pageId), options.serial === true)
      this.replicas.push(replica)
      if (skewMs !== 0) this.log(`${label} clock is ${skewMs > 0 ? '+' : '-'}1 day`)
    }
    for (const replica of this.replicas) {
      await replica.enable()
      await this.settle(replica, 'initial sync')
    }
  }

  async cleanup(): Promise<void> {
    for (const replica of this.replicas) await replica.cleanup()
  }

  /** One pass; an unexpected error (not a simulated crash, a dropped connection or Nessie down) is a problem. */
  async pass(replica: SimReplica, options: PassOptions = { scope: null }) {
    this.clock += 3_000
    const calls = replica.view.calls.length
    const journal = this.server.journal.length
    const outcome = await replica.pass(options)
    const made = this.server.journal.slice(journal)
      .filter((row) => row.actorExecutorId === replica.view.executorId)
      .map((row) => `${row.kind}:${row.title ?? ''}`)
    const sent = replica.view.calls.slice(calls).filter((call) => !['handshake', 'changes', 'report'].includes(call))
    if (sent.length > 0 || made.length > 0) this.log(`  ${replica.label} → ${sent.join(',')} | ${made.join(', ')}`)
    if (outcome.kind === 'failed' && !expectedFailure(outcome.error)) {
      const error = outcome.error as Error
      this.problems.push(`${replica.label}: a pass threw ${error?.name}: ${error?.message}\n${error?.stack ?? ''}`)
    }
    if (outcome.kind === 'failed') this.log(`${replica.label} pass failed: ${(outcome.error as Error)?.message}`)
    return outcome
  }

  /**
   * Passes until one has nothing more to do and nothing waiting to settle.
   * Answers whether it got there and whether any pass found work.
   */
  async settle(replica: SimReplica, why: string, maxPasses = 16): Promise<{ settled: boolean; worked: boolean }> {
    let worked = false
    for (let n = 0; n < maxPasses; n += 1) {
      const outcome = await this.pass(replica)
      if (outcome.kind === 'ran' && !outcome.result.more && outcome.result.retryInMs === null) return { settled: true, worked }
      worked = true
      if (outcome.kind === 'ran' && outcome.result.retryInMs !== null && outcome.result.retryInMs > 3_000) {
        this.clock += outcome.result.retryInMs
      }
    }
    this.problems.push(`${replica.label} did not settle within ${maxPasses} passes (${why})`)
    return { settled: false, worked }
  }

  /** Between a request and its answer: another writer may act, or another computer may sync. */
  private async duringTransfer(replica: SimReplica, operation: string, pageId: string | null): Promise<void> {
    if (!this.interference || this.nesting > 0 || !this.rng.chance(0.06)) return
    this.nesting += 1
    try {
      const what = this.rng.weighted<string>([[4, 'agent'], [4, 'typing'], [2, 'other']])
      this.log(`  during ${replica.label} ${operation}: ${what}`)
      if (what === 'agent' && pageId) actorEdit(this.person, this.server, 'agent', pageId)
      else if (what === 'typing' && pageId) await this.typeInto(replica, pageId)
      else if (what === 'other' && this.replicas.length > 1) {
        const other = this.rng.pick(this.replicas.filter((candidate) => candidate !== replica))
        await this.pass(other)
      }
    } finally {
      this.nesting -= 1
    }
  }

  /** The person keeps typing in the file of `pageId` on this computer (C30). */
  private async typeInto(replica: SimReplica, pageId: string): Promise<void> {
    const live = this.server.livePages().map((page) => this.server.project(page))
    const path = mapTree(this.server.spaces, live).paths.get(pageId)
    if (!path) return
    const items = await listTree(replica.teamDir())
    const file = items.find((item) => item.relPath === path && item.type === 'file')
    if (!file) return
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(file.absolute, 'utf8').catch(() => null)
    if (text === null) return
    await personWrite(this.person, replica.teamDir(), path, editedText(this.rng, text, this.person.token), `${replica.label} types`)
  }

  async step(): Promise<void> {
    const rng = this.rng
    const replica = rng.pick(this.replicas)
    this.clock += 1_000
    const kind = rng.weighted<string>([
      [30, 'pass'], [22, 'person'], [18, 'actor'], [6, 'network'], [5, 'crash'], [2, 'restart'], [5, 'decide'],
      [2, 'clock'],
    ])
    if (kind === 'pass') {
      const scope = rng.weighted<PassOptions['scope']>([[7, null], [1.5, []], [1.5, ['Projects']]])
      const snapshot = rng.chance(0.1)
      this.log(`${replica.label} pass${scope === null ? '' : ` scope=${JSON.stringify(scope)}`}${snapshot ? ' snapshot' : ''}`)
      await this.pass(replica, { scope, snapshot })
    } else if (kind === 'person') {
      await personOperation(this.person, replica.teamDir(), replica.label)
    } else if (kind === 'actor') {
      actorOperation(this.person, this.server)
    } else if (kind === 'network') {
      if (rng.chance(0.3)) {
        replica.view.offline = !replica.view.offline
        this.log(`${replica.label} ${replica.view.offline ? 'goes offline' : 'comes back online'}`)
      } else {
        const operation = rng.pick(FAULT_OPERATIONS)
        replica.view.faults.push(rng.chance(0.5)
          ? { operation, mode: 'lose_answer' }
          : { operation, mode: 'refuse', status: 503, code: 'EXECUTOR_FOLDER_SYNC_UNAVAILABLE' })
        this.log(`${replica.label} fault armed on ${operation}`)
      }
    } else if (kind === 'crash') {
      if (rng.chance(0.5)) {
        replica.transportCrash = { countdown: rng.between(1, 4), after: rng.chance(0.5) }
        this.log(`${replica.label} will crash at a transfer (${JSON.stringify(replica.transportCrash)})`)
      } else {
        const mode = rng.chance(0.5) ? 'before' : 'after'
        const countdown = rng.between(1, 8)
        replica.armRenameCrash(mode, countdown)
        this.log(`${replica.label} will crash at rename #${countdown} (${mode})`)
      }
      await this.pass(replica)
    } else if (kind === 'restart') {
      replica.restart()
      this.log(`${replica.label} daemon restarts`)
    } else if (kind === 'decide') {
      await this.decide(replica)
    } else {
      this.clock += rng.between(5, 90) * 60_000
      this.log('time passes')
    }
  }

  /** A person answers what waits on them: held deletes, or a conflict (in the console or in Nessie). */
  async decide(replica: SimReplica, heldOnly = false): Promise<boolean> {
    const rng = this.rng
    const state = await replica.state()
    if (state.heldDeletes) {
      const decision = rng.chance(0.5) ? 'confirm' : 'restore'
      await runConsoleCommand(replica.context, { command: 'held_deletes', batchId: state.heldDeletes.batchId, decision })
      this.log(`${replica.label} person ${decision}s ${state.heldDeletes.count} held deletes`)
      return true
    }
    if (heldOnly || state.conflicts.length === 0) return false
    const row = rng.pick(state.conflicts)
    const resolution = rng.weighted<'keep_mine' | 'keep_nessie' | 'dismiss'>([[2, 'keep_mine'], [2, 'keep_nessie'], [1, 'dismiss']])
    if (resolution === 'dismiss' || rng.chance(0.5)) {
      await runConsoleCommand(replica.context, { command: 'resolve', clientConflictId: row.clientConflictId, resolution })
      this.log(`${replica.label} person picks ${resolution} in the console for ${row.relPath}`)
    } else {
      // The person picks on the row Nessie shows them; one drawn before the row
      // changed carries an old `occurredAt`, which the resolve route refuses.
      const seen = replica.view.conflicts.get(row.clientConflictId)
      const expectedOccurredAt = rng.chance(0.8) && seen ? seen.occurredAt : '2020-01-01T00:00:00.000Z'
      const taken = replica.view.resolveInNessie(row.clientConflictId, resolution, expectedOccurredAt)
      this.log(`${replica.label} person picks ${resolution} in Nessie for ${row.relPath}${taken ? '' : ' (refused: stale)'}`)
    }
    return true
  }

  /** Everyone online, no faults: run every computer until a whole round changes nothing. */
  async quiesce(): Promise<boolean> {
    this.interference = false
    for (const replica of this.replicas) {
      replica.view.offline = false
      replica.view.faults = []
    }
    this.log('— quiesce —')
    for (let round = 0; round < 10; round += 1) {
      let busy = false
      for (const replica of this.replicas) {
        const { settled, worked } = await this.settle(replica, 'quiescence')
        if (!settled) return false
        if (worked || await this.decide(replica, true)) busy = true
      }
      if (!busy) return true
      this.clock += 61 * 60_000
    }
    this.problems.push('the computers never stopped finding work (livelock)')
    return false
  }
}

const expectedFailure = (error: unknown): boolean => {
  if (error instanceof SimulatedCrash) return true
  if (error instanceof TypeError && /fetch failed/u.test(error.message)) return true
  const code = (error as { code?: string } | null)?.code
  return code === 'EXECUTOR_FOLDER_SYNC_UNAVAILABLE'
}
