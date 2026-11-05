import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { LocalInferenceResourceControl, LocalInferenceTermination } from '@nessie/executor-protocol'
import { ExecutorInferenceSourceSchema, LocalInferenceTerminationSchema } from '@nessie/executor-protocol'
import { sameChatgptSource, type ChatgptInferenceSource } from './chatgpt-auth-provider.js'
import {
  acquireOwnerStateLock, acquirePhysicalInferenceStateLock, createAdmissionProcessInspector,
  type AdmissionProcessInspector, type PersonalAdmissionLockOptions,
} from './personal-admission-lock.js'
import {
  cloudCapacityFileDigest, posixCloudCapacityMutation, syncCloudCapacityDirectory, type CloudCapacityMutation,
} from './cloud-capacity-state.js'
import { CloudCapacityReceipts, sameCloudTerminationIdentity } from './cloud-capacity-receipts.js'
import { openInferenceResourceIdentity } from './inference-resource-identity.js'

import {
  ensureOwnerOnlyStateDirectory, assertOwnerOnlyStatePath, secureOwnerOnlyStateFile, type StateSecurityDeps,
} from './state-security.js'

type CoordinatorState = {
  capacity: number; controlRevision: number; paused: boolean; resourceId: string | null
  pendingAction: 'pause' | 'resume' | null
}
type Slot = {
  owner: string
  hostId: string | null
  pid: number
  state: 'reserved' | 'running' | 'confirmed' | 'uncertain'
  termination: LocalInferenceTermination | null
  /** When the poll token was issued; absent on a slot written before it was recorded. */
  reservedAt?: number
  processStartedAt?: string
}
type CoordinatorOptions = {
  directory?: string; security?: StateSecurityDeps; now?: () => number
  processes?: AdmissionProcessInspector; lock?: PersonalAdmissionLockOptions
  /** Windows production supplies only the verified native personal-state consumer. */
  cloudMutation?: CloudCapacityMutation
  cloudBarrier?: (directory: string) => Promise<void>
}

type PollIntent = { hostId: string; pid: number; expiresAt: number }
const POLL_INTENT_TTL_MS = 5_000
const MAX_POLL_INTENTS = 256
/** Only an unbound poll token can expire; binding is durable before invocation. */
export const STALE_RESERVATION_MS = 5 * 60_000

/** The slot a lease pointed at was reclaimed or settled by another transport. */
export class LocalInferenceSlotFencedError extends Error {
  override readonly name = 'LocalInferenceSlotFencedError'
  constructor() { super('Local inference slot was fenced.') }
}

const pollIntentsAreValid = (value: unknown): value is PollIntent[] => {
  if (!Array.isArray(value) || value.length > MAX_POLL_INTENTS) return false
  const hosts = new Set<string>()
  return value.every((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const intent = candidate as PollIntent
    if (Object.keys(candidate).length !== 3 || typeof intent.hostId !== 'string'
      || intent.hostId.length === 0 || intent.hostId.length > 128 || hosts.has(intent.hostId)
      || !Number.isSafeInteger(intent.pid) || intent.pid < 1
      || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt < 1) return false
    hosts.add(intent.hostId)
    return true
  })
}

export type LocalInferenceCoordinatorLease = {
  requestId: string
  abandonPoll: () => Promise<void>
  bind: (termination: Omit<LocalInferenceTermination, 'confirmed'>) => Promise<void>
  finish: (confirmed: boolean) => Promise<void>
  releaseIdle: () => Promise<void>
}

const stateIsValid = (value: unknown): value is CoordinatorState => {
  if (!value || typeof value !== 'object') return false
  const state = value as CoordinatorState
  return Number.isInteger(state.capacity) && state.capacity >= 1 && state.capacity <= 16
    && Number.isInteger(state.controlRevision) && state.controlRevision >= 0
    && typeof state.paused === 'boolean' && (state.resourceId === null || typeof state.resourceId === 'string')
    && (state.pendingAction === null || state.pendingAction === 'pause' || state.pendingAction === 'resume')
}

const slotIsValid = (value: unknown): value is Slot => {
  if (!value || typeof value !== 'object') return false
  const slot = value as Slot
  return typeof slot.owner === 'string' && Number.isSafeInteger(slot.pid) && slot.pid >= 0
    && (slot.hostId === null || typeof slot.hostId === 'string')
    && ['reserved', 'running', 'confirmed', 'uncertain'].includes(slot.state)
    && (slot.termination === null || LocalInferenceTerminationSchema.safeParse(slot.termination).success)
    && (slot.reservedAt === undefined || Number.isSafeInteger(slot.reservedAt) && slot.reservedAt >= 0)
    && (slot.processStartedAt === undefined || /^[0-9]+$/.test(slot.processStartedAt))
}

const processIsAlive = (pid: number): boolean => {
  if (pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** OS-wide physical capacity never expires; cloud pools release transport only. */
export class LocalInferenceCoordinator {
  private readonly cloudReceipts?: CloudCapacityReceipts
  private constructor(
    private readonly directory: string,
    private readonly security: StateSecurityDeps,
    readonly identity: { privateKey: string; publicKey: string },
    private readonly now: () => number,
    readonly inferenceSource?: ChatgptInferenceSource,
    private readonly processes: AdmissionProcessInspector = createAdmissionProcessInspector(),
    private readonly lockOptions: PersonalAdmissionLockOptions = {},
    private readonly cloudMutation?: CloudCapacityMutation,
    cloudBarrier?: (directory: string) => Promise<void>,
  ) {
    if (inferenceSource) this.cloudReceipts = new CloudCapacityReceipts(directory, inferenceSource, {
      read: (name) => this.read(name), replace: (name, value) => this.replace(name, value),
      remove: (name) => this.remove(name), mutate: (fn) => this.mutate(fn),
      barrier: () => (cloudBarrier ?? syncCloudCapacityDirectory)(directory),
    })
  }

  static async open(
    options: CoordinatorOptions = {},
  ): Promise<LocalInferenceCoordinator> {
    return this.openResource(options)
  }

  /** A distinct cloud transport pool; it never proves provider stop or usage settlement. */
  static async openChatgpt(
    source: ChatgptInferenceSource,
    options: CoordinatorOptions = {},
  ): Promise<LocalInferenceCoordinator> {
    const parsed = ExecutorInferenceSourceSchema.parse(source)
    if (parsed.kind !== 'chatgpt') throw new Error('ChatGPT resource requires an exact profile source.')
    if (process.platform === 'win32' && (!options.cloudMutation || !options.cloudBarrier)) {
      throw new Error('Cloud capacity requires the verified native state consumer.')
    }
    const directory = options.directory ?? join(homedir(), '.nessie', 'personal-inference', 'cloud-capacity',
      parsed.profileId, String(parsed.accountGeneration), String(parsed.consentRevision))
    return this.openResource({ ...options, directory }, parsed)
  }

  private static async openResource(
    options: CoordinatorOptions,
    source?: ChatgptInferenceSource,
  ): Promise<LocalInferenceCoordinator> {
    const security = options.security ?? {}
    const directory = await ensureOwnerOnlyStateDirectory(
      options.directory ?? join(homedir(), '.nessie', 'local-inference'), security,
    )
    const mutation = source ? options.cloudMutation ?? posixCloudCapacityMutation(security) : undefined
    const identity = await openInferenceResourceIdentity(directory, security, mutation ? { mutate: mutation,
      barrier: options.cloudBarrier ?? syncCloudCapacityDirectory } : undefined)
    const coordinator = new LocalInferenceCoordinator(directory, security, identity, options.now ?? Date.now, source,
      options.processes, options.lock, mutation, options.cloudBarrier)
    await coordinator.mutate(async () => {
      const storedSource = await coordinator.read('source.json')
      if (source) {
        if (storedSource !== null && JSON.stringify(storedSource) !== JSON.stringify(source)) {
          throw new Error('ChatGPT capacity source needs repair.')
        }
        if (storedSource === null) {
          // A pre-existing physical control must never be reinterpreted as cloud.
          if (await coordinator.read('control.json') !== null) {
            throw new Error('Inference capacity source needs repair.')
          }
          await coordinator.replace('source.json', source)
        }
      } else if (storedSource !== null) throw new Error('A cloud resource cannot become physical Ollama capacity.')
      if (await coordinator.read('control.json') === null) {
        await coordinator.replace('control.json', {
          capacity: 1, controlRevision: 0, paused: false, resourceId: null, pendingAction: null,
        })
      }
    })
    return coordinator
  }

  async control(): Promise<CoordinatorState> {
    const state = await this.read('control.json')
    if (!stateIsValid(state)) throw new Error('Local inference resource control needs repair.')
    return state
  }

  async syncControl(control: LocalInferenceResourceControl, acknowledgedAction?: 'pause' | 'resume'): Promise<void> {
    this.assertSource(control.inferenceSource)
    await this.mutate(async () => {
      const current = await this.control()
      if (current.resourceId !== null && current.resourceId !== control.resourceId) {
        throw new Error('This OS account is already enrolled with a different inference resource.')
      }
      if (control.controlRevision < current.controlRevision) return
      await this.replace('control.json', {
        capacity: control.capacity, controlRevision: control.controlRevision,
        paused: current.pendingAction === 'pause' && acknowledgedAction !== 'pause' || control.paused,
        resourceId: control.resourceId,
        pendingAction: current.pendingAction === acknowledgedAction ? null : current.pendingAction,
      })
    })
  }

  /** An offline pause is durable before contacting Nessie; only explicit resume clears it. */
  async pause(): Promise<void> {
    await this.mutate(async () => {
      await this.replace('control.json', { ...await this.control(), paused: true, pendingAction: 'pause' })
    })
  }

  async resume(): Promise<void> {
    await this.mutate(async () => {
      await this.replace('control.json', { ...await this.control(), pendingAction: 'resume' })
    })
  }

  /** Called only after the person explicitly confirms their Ollama requests stopped. */
  async confirmStopped(): Promise<void> {
    if (this.inferenceSource) throw new Error('Cloud transport release cannot confirm provider termination.')
    await this.mutate(async () => {
      for (let index = 0; index < 16; index += 1) {
        const name = `slot-${index}.json`
        const slot = await this.read(name)
        if (slot === null) continue
        if (!slotIsValid(slot)) throw new Error('Local inference slot metadata needs repair.')
        if (slot.state === 'reserved' && slot.hostId) {
          throw new Error('Reconnect the original host to reconcile its pending poll before confirming termination.')
        }
        if (['reserved', 'running'].includes(slot.state) && processIsAlive(slot.pid)) {
          throw new Error('A Nessie host still owns an active request. Stop that host before confirming termination.')
        }
        if (slot.termination) {
          await this.replace(name, { ...slot, state: 'confirmed',
            termination: { ...slot.termination, confirmed: true } })
        } else await unlink(join(this.directory, name))
      }
    })
  }

  async healthReason(): Promise<'termination_uncertain' | null> {
    if (this.inferenceSource) return null
    for (let index = 0; index < 16; index += 1) {
      const slot = await this.read(`slot-${index}.json`)
      if (slot === null) continue
      if (!slotIsValid(slot) || slot.state === 'uncertain'
        || slot.state === 'running' && !processIsAlive(slot.pid)) return 'termination_uncertain'
    }
    return null
  }

  async acquire(hostId?: string): Promise<LocalInferenceCoordinatorLease | null> {
    return this.mutate(async () => {
      if (this.inferenceSource) {
        await this.reconcileCloudSlots()
        if ((await this.cloudReceipts!.count()) >= 1024) return null
      }
      for (let index = 0; index < 16; index += 1) {
        const name = `slot-${index}.json`
        const slot = await this.read(name)
        if (!slotIsValid(slot) || slot.state !== 'reserved' || slot.termination) continue
        // Reuse a dead owner's unbound token to reconcile its interrupted admission.
        if (hostId && slot.hostId === hostId && (slot.pid === 0 || (this.inferenceSource
          ? await this.cloudOwnerIsGone(slot) : !processIsAlive(slot.pid)))) {
          await this.replace(name, { ...slot, pid: process.pid, ...await this.cloudProcessGeneration() })
          return this.lease(name, slot.owner)
        }
        // Stale unbound tokens are fenced; an accepted generation never expires.
        if (await this.reservationIsStale(name, slot)) await this.remove(name)
      }
      const control = await this.control()
      if (control.paused || await this.healthReason()) return null
      // Count all slots, including those above a newly lowered limit: lowering
      // capacity drains existing calls rather than admitting under new indices.
      let occupied = 0
      const empty: number[] = []
      for (let index = 0; index < 16; index += 1) {
        if (await this.read(`slot-${index}.json`) === null) empty.push(index)
        else occupied += 1
      }
      const index = empty[0]
      if (!await this.takePollTurn(hostId, occupied < control.capacity && index !== undefined)) return null
      if (index === undefined) return null
      const name = `slot-${index}.json`
      const owner = randomUUID()
      await this.replace(name, { owner, hostId: hostId ?? null, pid: process.pid, state: 'reserved',
        termination: null, reservedAt: this.now(), ...await this.cloudProcessGeneration() } satisfies Slot)
      return this.lease(name, owner)
    })
  }

  /** A slot written before `reservedAt` existed is dated by its last write. */
  private async reservationIsStale(name: string, slot: Slot): Promise<boolean> {
    const reservedAt = slot.reservedAt ?? (await lstat(join(this.directory, name))).mtimeMs
    return this.now() - reservedAt > STALE_RESERVATION_MS
  }

  /** Only unserved scheduling intent expires; a physical reservation never does. */
  private async takePollTurn(hostId: string | undefined, available: boolean): Promise<boolean> {
    const name = 'poll-waiters.json'
    const stored = await this.read(name, pollIntentsAreValid) as PollIntent[] | null
    const now = this.now()
    const waiting = (stored ?? []).filter((intent) => intent.expiresAt > now && processIsAlive(intent.pid))
    const first = waiting[0]
    const admitted = available && (first === undefined || first.hostId === hostId)
    if (admitted) {
      if (first) waiting.shift()
    } else if (hostId) {
      const existing = waiting.findIndex((intent) => intent.hostId === hostId)
      const refreshed = { hostId, pid: process.pid, expiresAt: now + POLL_INTENT_TTL_MS }
      if (existing >= 0) waiting[existing] = refreshed
      else {
        if (waiting.length >= MAX_POLL_INTENTS) throw new Error('Too many local inference hosts are waiting to poll.')
        waiting.push(refreshed)
      }
    }
    // Uncontended polling writes no intent file. A refused/failed reservation
    // may lose only its scheduling turn; it has not contacted the server yet.
    if (JSON.stringify(stored ?? []) !== JSON.stringify(waiting)) {
      if (waiting.length) await this.replace(name, waiting)
      else await this.remove(name)
    }
    return admitted
  }

  private lease(name: string, owner: string): LocalInferenceCoordinatorLease {
    const update = async (fn: (slot: Slot) => Promise<void>): Promise<void> => this.mutate(async () => {
      const slot = await this.read(name)
      if (!slotIsValid(slot) || slot.owner !== owner) throw new LocalInferenceSlotFencedError()
      await fn(slot)
    })
    return {
      requestId: owner,
      abandonPoll: () => update(async (slot) => {
        if (slot.state === 'reserved') await this.replace(name, { ...slot, pid: 0 })
      }),
      bind: (termination) => update(async (slot) => {
        this.assertSource(termination.inferenceSource)
        if (slot.state !== 'reserved' || slot.termination) throw new Error('Local inference slot is already bound.')
        await this.replace(name, { ...slot, state: 'running', termination: { ...termination, confirmed: false } })
      }),
      finish: (confirmed) => update(async (slot) => {
        if (!slot.termination) throw new Error('Local inference slot is not bound.')
        if (this.inferenceSource) {
          await this.queueCloudTermination(name, { ...slot, termination: { ...slot.termination, confirmed } })
          return
        }
        await this.replace(name, {
          ...slot, state: confirmed ? 'confirmed' : 'uncertain', termination: { ...slot.termination, confirmed },
        })
      }),
      releaseIdle: () => update(async (slot) => {
        if (slot.state !== 'reserved' || slot.termination) {
          throw new Error('An active local inference slot cannot expire.')
        }
        await this.remove(name)
      }),
    }
  }

  /** Cloud receipt-origin GC requires actual slot and namespace absence. */
  hasPendingTermination = (attemptId?: string): Promise<boolean> => this.cloudReceipts
    ? this.cloudReceipts.hasPendingAttempt(attemptId, name => this.read(name), slotIsValid)
    : Promise.reject(new Error('Historical receipt absence requires a cloud coordinator.'))

  hasPendingCloudWork = (): Promise<boolean> => this.hasPendingTermination()

  async flushTerminations(submit: (termination: LocalInferenceTermination) => Promise<void>): Promise<void> {
    if (this.inferenceSource) {
      await this.mutate(() => this.reconcileCloudSlots())
      await this.cloudReceipts!.flush(submit, () => this.reconcileCloudSlots())
      return
    }
    for (let index = 0; index < 16; index += 1) {
      const name = `slot-${index}.json`
      const slot = await this.read(name)
      if (!slotIsValid(slot) || !slot.termination || !['confirmed', 'uncertain'].includes(slot.state)) continue
      await submit(slot.termination)
      if (slot.state !== 'confirmed') continue
      await this.mutate(async () => {
        const current = await this.read(name)
        if (slotIsValid(current) && current.owner === slot.owner && current.state === 'confirmed') {
          await unlink(join(this.directory, name))
        }
      })
    }
  }

  private assertSource(source: LocalInferenceTermination['inferenceSource']): void {
    if (this.inferenceSource ? source?.kind !== 'chatgpt' || !sameChatgptSource(this.inferenceSource, source)
      : source?.kind === 'chatgpt') throw new Error('Inference resource source does not match its capacity pool.')
  }

  /** Durable receipt publication precedes release of local transport ownership. */
  private async queueCloudTermination(name: string, slot: Slot): Promise<void> {
    if (!slot.termination || !this.cloudReceipts) throw new Error('Cloud inference slot needs repair.')
    const value = LocalInferenceTerminationSchema.parse(slot.termination)
    this.assertSource(value.inferenceSource)
    await this.cloudReceipts.record(slot.owner, value)
    await this.remove(name)
  }
  private async reconcileCloudSlots(): Promise<void> {
    for (let index = 0; index < 16; index++) {
      const name = `slot-${index}.json`
      const slot = await this.read(name)
      if (slot === null) continue
      if (!slotIsValid(slot)) throw new Error('Cloud slot metadata needs repair.')
      const receipt = await this.cloudReceipts!.pending(slot.owner)
      if (receipt !== null) {
        // Publication is the cleanup intent even while its process is alive.
        // Never ACK its receipt until matching local ownership is durably removed.
        if (!slot.termination || !sameCloudTerminationIdentity(slot.termination, receipt)) {
          throw new Error('Cloud termination receipt conflicts with slot ownership.')
        }
        await this.cloudReceipts!.stabilize(slot.owner)
        await this.remove(name)
        continue
      }
      if (slot.termination && (slot.state === 'uncertain' || slot.state === 'confirmed'
        || slot.state === 'running' && await this.cloudOwnerIsGone(slot))) {
        // Dead transport is unknown, including when the provider may have completed.
        await this.queueCloudTermination(name, { ...slot,
          termination: { ...slot.termination, confirmed: slot.state === 'confirmed' } })
      }
    }
  }

  private async cloudProcessGeneration(): Promise<{ processStartedAt?: string }> {
    if (!this.inferenceSource) return {}
    const identity = await this.processes.identify(process.pid)
    if (!identity || identity.pid !== process.pid || !/^[0-9]+$/.test(identity.startedAt)) {
      throw new Error('Cloud transport process generation is unavailable.')
    }
    return { processStartedAt: identity.startedAt }
  }

  private async cloudOwnerIsGone(slot: Slot): Promise<boolean> {
    if (slot.pid === 0) return true
    if (!slot.processStartedAt) throw new Error('Cloud transport process generation needs repair.')
    const current = await this.processes.identify(slot.pid)
    return current ? current.startedAt !== slot.processStartedAt : !this.processes.isAlive(slot.pid)
  }

  private async read(name: string, validate?: (value: unknown) => boolean): Promise<unknown | null> {
    const path = join(this.directory, name)
    try {
      await assertOwnerOnlyStatePath(path, 'file', this.security)
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (validate && !validate(value)) throw new Error(`Local inference ${name} metadata needs repair.`)
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  private async replace(name: string, value: unknown): Promise<void> {
    const path = join(this.directory, name)
    if (this.cloudMutation) {
      await this.cloudMutation(path, { operation: 'replace', bytes: Buffer.from(`${JSON.stringify(value)}\n`),
        expectedDigest: await cloudCapacityFileDigest(path) })
      return
    }
    const temporary = `${path}.${randomUUID()}.new`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() }
    finally { await file.close() }
    try {
      await secureOwnerOnlyStateFile(temporary, this.security)
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => undefined) }
  }

  private async remove(name: string): Promise<void> {
    const path = join(this.directory, name)
    if (!this.cloudMutation) { await unlink(path); return }
    const expectedDigest = await cloudCapacityFileDigest(path)
    if (expectedDigest !== null) await this.cloudMutation(path, { operation: 'delete', expectedDigest })
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      let lease
      try {
        const options = {
          ...this.lockOptions, security: this.security, processes: this.processes,
        }
        lease = await (this.inferenceSource ? acquireOwnerStateLock(this.directory, 'mutation.lock', options)
          : acquirePhysicalInferenceStateLock(this.directory, options))
      } catch (error) {
        if ((error as { code?: string }).code !== 'personal_inference_admission_busy') throw error
        await delay(10)
        continue
      }
      try { return await fn() } finally { await lease.release() }
    }
    throw new Error('Local inference coordinator is busy or needs repair.')
  }
}
