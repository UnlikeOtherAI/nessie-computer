import { retainPersonalReceiptAttempt, type PersonalReceiptTransport } from './personal-receipt-transport.js'
export type { PersonalReceiptAttempt, PersonalReceiptTransport } from './personal-receipt-transport.js'
import { ChatgptError } from './chatgpt-errors.js'
import {
  LocalInferenceResourceAdmissionSchema,
  LocalInferenceResourceControlSchema, sameExecutorInferenceSource,
  type LocalInferenceAttemptControlState,
  type LocalInferenceAttemptRequest,
  type LocalInferenceResult, type LocalInferenceResourceAdmission,
} from '@nessie/executor-protocol'
import { signLocalInferenceResourceAttachment } from '@nessie/local-inference-host'

import {
  LocalInferenceApiError,
  type LocalInferenceAttemptLease,
  type LocalInferenceHostTransport,
  type LocalInferenceResultReceipt as ApiResultReceipt,
} from './local-inference-api.js'
import {
  EncryptedLocalInferenceReceiptJournal,
  LocalInferenceReceiptError,
  type LocalInferenceResultReceipt as JournalResultReceipt,
} from './local-inference-receipts.js'
import { observeOllamaInventory } from './ollama-observed.js'
import { type OllamaFetch } from './ollama-client.js'
import {
  LocalInferenceSlotFencedError, type LocalInferenceCoordinator, type LocalInferenceCoordinatorLease,
} from './local-inference-coordinator.js'
import { encodeLocalInferenceFrames, type LocalInferenceStreamFrameType } from './local-inference-frames.js'
import { runLocalInferenceGeneration } from './local-inference-generation.js'
import { localInferenceFailure, type LocalInferenceFailure } from './local-inference-failure.js'
import type { LocalInferenceBackend } from './local-inference-backend.js'
import {
  capabilityFor, deadlinePassed, errorResult, knownCapabilities, matchesSelectedModel, publishedModel,
  type EligibleModel,
} from './local-inference-host-model.js'

/**
 * The server answered the claim itself and refused it (a client error), so it
 * admitted nothing under this token. Only a lost or timed-out answer leaves
 * an admission the same token must go back for.
 */
class DeferredPersonalReceiptError extends Error {
  override readonly name = 'DeferredPersonalReceiptError'
  constructor() { super('personal_receipt_delivery_deferred') }
}

const definitivePollRefusal = (error: unknown): boolean => error instanceof LocalInferenceApiError
  && error.status !== undefined && error.status >= 400 && error.status < 500

export type LocalInferenceHostIdentity = {
  connectionEpoch: string
  executorConnectionEpoch?: string
  hostId: string
  machinePrivateKey: string
  organizationId: string
}


export type LocalInferencePollOutcome =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'refused'; reason: 'protected_storage_unavailable' }
  | { attemptId: string; kind: 'completed' }
  | { attemptId: string; kind: 'fenced' }

/** A claim's answer; a started generation runs on, and `completion` settles when it ends. */
export type LocalInferenceClaimOutcome =
  | LocalInferencePollOutcome
  | { attemptId: string; completion: Promise<LocalInferencePollOutcome>; kind: 'started' }

/**
 * A single-host relay loop. Nothing in its public surface permits a model to
 * select a URL, header, command or a different local model. The pairing/native
 * layer supplies its already-authorized identity and protected receipt journal;
 * the transport signs and carries every message.
 */
export class LocalInferenceHostLoop {
  #active = new Map<string, AbortController>()
  #frameSequences = new Map<string, number>()
  #polling = false
  #stopped = false
  #pendingPoll: LocalInferenceCoordinatorLease | null = null

  constructor(private readonly dependencies: {
    transport: LocalInferenceHostTransport
    backend?: LocalInferenceBackend
    coordinator: Pick<LocalInferenceCoordinator,
      'identity' | 'control' | 'syncControl' | 'healthReason' | 'acquire' | 'flushTerminations' | 'inferenceSource'>
    fetchImpl?: OllamaFetch
    identity: LocalInferenceHostIdentity
    isPaused: () => boolean
    journal: EncryptedLocalInferenceReceiptJournal
    personalReceipts?: PersonalReceiptTransport
    now?: () => Date
    onFailure?: (failure: LocalInferenceFailure & { attemptId: string; generationTerminated: boolean }) => void
    origin: string
  }) {}

  async heartbeat(): Promise<void> {
    await this.syncResource()
    const now = this.now()
    const inventory = this.dependencies.backend
      ? { models: await this.dependencies.backend.observe() }
      : await observeOllamaInventory(this.dependencies.origin, this.dependencies.fetchImpl)
    await this.dependencies.transport.heartbeat({
      inventory: inventory.models.map((model) => publishedModel(model, now.toISOString())),
      paused: this.dependencies.isPaused() || (await this.dependencies.coordinator.control()).paused,
    })
  }

  /** Claim once and wait for whatever it started to finish. */
  async pollOnce(): Promise<LocalInferencePollOutcome> {
    const outcome = await this.claimOnce()
    return outcome.kind === 'started' ? outcome.completion : outcome
  }

  /**
   * Replay what is owed, reserve a local slot, and claim under its token.
   * Answers as soon as the claim is settled; a leased generation continues
   * beside the next claim, so one host can fill every configured slot.
   */
  async claimOnce(): Promise<LocalInferenceClaimOutcome> {
    if (this.#stopped || this.dependencies.isPaused()) await this.reconcileReceipts()
    if (this.#polling || this.#stopped || this.dependencies.isPaused()) return { kind: 'idle' }
    this.#polling = true
    let pollingReleased = false
    const releasePoll = () => { if (!pollingReleased) { pollingReleased = true; this.#polling = false } }
    let slot: LocalInferenceCoordinatorLease | null = null
    let bound = false
    let ran = false
    let answered = false
    let refused = false
    try {
      let pending: JournalResultReceipt[]
      try { pending = await this.dependencies.journal.pending() }
      catch (error) {
        if (error instanceof LocalInferenceReceiptError) return {
          kind: 'refused', reason: 'protected_storage_unavailable' }
        throw error
      }
      for (const receipt of pending) {
        try { await this.submitReceipt(receipt) }
        catch (error) { if (!(error instanceof DeferredPersonalReceiptError)) throw error }
      }
      if (pending[0] && !this.dependencies.coordinator.inferenceSource) {
        return { attemptId: pending[0].attemptId, kind: 'completed' }
      }
      await this.flushTerminations()
      slot = this.#pendingPoll ?? await this.dependencies.coordinator.acquire(this.dependencies.identity.hostId)
      if (!slot) return { kind: 'busy' }
      this.#pendingPoll = slot
      let lease: LocalInferenceAttemptLease
      try {
        lease = await this.dependencies.transport.claim({ requestId: slot.requestId,
          ...(this.dependencies.coordinator.inferenceSource
            ? { inferenceSource: this.dependencies.coordinator.inferenceSource } : {}),
        })
      } catch (error) {
        refused = definitivePollRefusal(error)
        throw error
      }
      if (lease.attempt === null && lease.dispatchFence === null && lease.admission === null) {
        answered = true
        return { kind: 'idle' }
      }
      if (!lease.attempt || !lease.admission) throw new Error('Local inference poll response is incomplete.')
      const admission = LocalInferenceResourceAdmissionSchema.parse(lease.admission)
      try {
        await slot.bind({ ...admission, attemptId: lease.attempt.attemptId })
      } catch (error) {
        if (!(error instanceof LocalInferenceSlotFencedError)) throw error
        // The token's slot was reclaimed while its answer was on the way. The
        // model was never invoked, so that is the one honest terminal proof,
        // and the server releases the admission it had committed for it.
        this.#pendingPoll = null
        answered = true
        slot = null
        const termination = { ...admission, attemptId: lease.attempt.attemptId, confirmed: true }
        await this.dependencies.transport.terminate(termination)
        return { attemptId: lease.attempt.attemptId, kind: 'fenced' }
      }
      bound = true
      answered = true
      if (this.#stopped || (await this.dependencies.coordinator.control()).paused) {
        return { attemptId: lease.attempt.attemptId, kind: 'fenced' }
      }
      if (lease.dispatchFence === null || !Number.isSafeInteger(lease.dispatchFence) || lease.dispatchFence < 1) {
        return { attemptId: lease.attempt.attemptId, kind: 'fenced' }
      }
      if (!this.isCurrentLease(lease.attempt)) return { attemptId: lease.attempt.attemptId, kind: 'fenced' }
      if (deadlinePassed(lease.attempt, this.now())) return { attemptId: lease.attempt.attemptId, kind: 'fenced' }

      const journalReceipt = { attemptId: lease.attempt.attemptId, dispatchFence: lease.dispatchFence }
      let recovered: JournalResultReceipt | undefined
      try {
        recovered = await this.dependencies.journal.get(journalReceipt)
      } catch (error) {
        if (error instanceof LocalInferenceReceiptError) {
          return { kind: 'refused', reason: 'protected_storage_unavailable' }
        }
        throw error
      }
      if (recovered !== undefined) {
        await this.submitReceipt(recovered)
        return { attemptId: lease.attempt.attemptId, kind: 'completed' }
      }
      ran = true
      this.#pendingPoll = null
      releasePoll()
      const { attempt, dispatchFence } = { attempt: lease.attempt, dispatchFence: lease.dispatchFence }
      const bodySlot = slot
      const completion = (async () => {
        try { return await this.run(attempt, dispatchFence, bodySlot, admission) }
        finally { await this.flushTerminations() }
      })()
      return { attemptId: attempt.attemptId, completion, kind: 'started' }
    } finally {
      try {
        if (answered && bound && !pollingReleased) this.#pendingPoll = null
        if (slot && (answered || refused) && !bound) {
          // A busy shared mutation can refuse release. Keep its token until
          // release is durable, so the next claim can settle this same slot.
          // A slot another transport already reclaimed needs no release.
          try { await slot.releaseIdle() }
          catch (error) { if (!(error instanceof LocalInferenceSlotFencedError)) throw error }
          this.#pendingPoll = null
        }
        if (slot && bound && !ran) await slot.finish(true)
        if (!ran) await this.flushTerminations()
        if (this.#stopped && this.#pendingPoll) await this.#pendingPoll.abandonPoll()
      } finally { releasePoll() }
    }
  }

  /** A pushed cancel or fence aborts the model request it names, at once. */
  applyControl(attemptId: string, state: Exclude<LocalInferenceAttemptControlState, 'active'>): void {
    this.#active.get(attemptId)?.abort(state)
  }

  /** Stop every in-flight local request when this host loses its authority. */
  stop(): void {
    this.#stopped = true
    for (const controller of this.#active.values()) controller.abort('host_stopped')
    if (!this.#polling && this.#pendingPoll) void this.#pendingPoll.abandonPoll().catch(() => undefined)
  }

  private async run(
    attempt: LocalInferenceAttemptRequest, dispatchFence: number, slot: LocalInferenceCoordinatorLease,
    admission: LocalInferenceResourceAdmission,
  ): Promise<LocalInferencePollOutcome> {
    let invoked = false
    let confirmed = false
    let receiptRecorded = false
    const controller = new AbortController()
    this.#active.set(attempt.attemptId, controller)
    this.#frameSequences.set(attempt.attemptId, 1)
    const remainingMs = new Date(attempt.deadlineAt).valueOf() - this.now().valueOf()
    const deadlineTimer = setTimeout(() => controller.abort('deadline_exceeded'), Math.max(1, remainingMs))
    let model: EligibleModel | undefined
    try {
      model = await this.selectedModel(attempt)
      if (model === undefined || (attempt.tools.length > 0 && !knownCapabilities(model).includes('tools'))) {
        this.submitErrorFrame(attempt, dispatchFence, model === undefined ? 'model_missing' : 'unsupported_capability')
        return { attemptId: attempt.attemptId, kind: 'fenced' }
      }
      if (model.numCtxCap !== null && attempt.numCtx > model.numCtxCap) {
        this.submitErrorFrame(attempt, dispatchFence, 'context_too_large')
        return { attemptId: attempt.attemptId, kind: 'fenced' }
      }

      if (attempt.inferenceSource?.kind === 'chatgpt') {
        await retainPersonalReceiptAttempt({ attempt, dispatchFence, admission,
          host: this.dependencies.identity, journal: this.dependencies.journal,
          transport: this.dependencies.personalReceipts })
        // Durable server acceptance owns provider dispatch. Lost/failed ACK never starts a POST.
        let answer: { state: LocalInferenceAttemptControlState }
        try { answer = await this.dependencies.transport.accept({ attemptId: attempt.attemptId, dispatchFence }) }
        catch { throw new ChatgptError('chatgpt_unavailable', 'not_sent') }
        if (answer.state !== 'active' || controller.signal.aborted) {
          throw new ChatgptError('chatgpt_cancelled', 'not_sent')
        }
        try {
          await this.dependencies.personalReceipts!.prepareInvocation({ attemptId: attempt.attemptId, dispatchFence })
        } catch { throw new ChatgptError('chatgpt_unavailable', 'not_sent') }
      } else {
        // The existing weights host receives cancellation beside its local request.
        void this.dependencies.transport.accept({ attemptId: attempt.attemptId, dispatchFence })
          .then((answer) => { if (answer.state !== 'active') controller.abort(answer.state) })
          .catch(() => undefined)
      }
      invoked = true
      const result = await this.invoke(attempt, dispatchFence, model, controller.signal, async () => {
        await slot.finish(true)
        confirmed = true
      })
      // A second observation catches a selected tag changing while Ollama was
      // generating. A terminal result is never accepted on that stale digest.
      if (await this.selectedModel(attempt) === undefined) return { attemptId: attempt.attemptId, kind: 'fenced' }
      const receipt = { attemptId: attempt.attemptId, dispatchFence, result }
      await this.dependencies.journal.record(receipt)
      receiptRecorded = true
      await this.submitReceipt(receipt)
      return { attemptId: attempt.attemptId, kind: 'completed' }
    } catch (error) {
      const failure = localInferenceFailure(error)
      const diagnostic = { attemptId: attempt.attemptId, generationTerminated: confirmed, ...failure }
      if (this.dependencies.onFailure) this.dependencies.onFailure(diagnostic)
      else console.error('[nessie-executor] local inference failed:', diagnostic)
      // A durable successful receipt owns recovery. A lost result ACK must not
      // poison its already streamed answer with a new error frame or receipt.
      if (receiptRecorded) return { attemptId: attempt.attemptId, kind: 'completed' }
      if (model === undefined) return { attemptId: attempt.attemptId, kind: 'fenced' }
      this.submitErrorFrame(attempt, dispatchFence, failure.code)
      const receipt = { attemptId: attempt.attemptId, dispatchFence,
        result: errorResult(attempt, model, this.now(), error) }
      try {
        await this.dependencies.journal.record(receipt)
        await this.submitReceipt(receipt)
      } catch {
        if (!invoked && attempt.inferenceSource?.kind === 'chatgpt') {
          // Pre-POST refusal can dispose through the retained origin without reserving outcome bytes.
          await this.submitReceipt(receipt).catch(() => undefined)
        }
        // The receipt remains in protected storage for a duplicate lease. No
        // retry here can rerun a model call whose outcome is already ambiguous.
      }
      return { attemptId: attempt.attemptId, kind: 'completed' }
    } finally {
      clearTimeout(deadlineTimer)
      this.#active.delete(attempt.attemptId)
      this.#frameSequences.delete(attempt.attemptId)
      if (!confirmed) { controller.abort('host_failed'); await slot.finish(!invoked) }
    }
  }

  private invoke(
    attempt: LocalInferenceAttemptRequest,
    dispatchFence: number,
    model: EligibleModel,
    signal: AbortSignal,
    terminal: () => Promise<void>,
  ): Promise<LocalInferenceResult> {
    return runLocalInferenceGeneration({
      attempt, capability: () => capabilityFor(attempt, model, this.now()),
      fetchImpl: this.dependencies.fetchImpl, origin: this.dependencies.origin, signal, terminal,
      stream: this.dependencies.backend?.stream,
      think: attempt.thinking === true && knownCapabilities(model).includes('thinking'),
      publish: (type: LocalInferenceStreamFrameType, text: string, final: boolean) => {
        const encoded = encodeLocalInferenceFrames(type, text, final)
        encoded.forEach((data, index) => this.dependencies.transport.frame({
          attemptId: attempt.attemptId, data, dispatchFence, final: final && index === encoded.length - 1,
          sequence: this.nextFrameSequence(attempt.attemptId),
        }))
      },
    })
  }

  /** The stream's last word when it failed: relayed if anyone is watching, never stored. */
  private submitErrorFrame(attempt: LocalInferenceAttemptRequest, dispatchFence: number, code: string): void {
    this.dependencies.transport.frame({
      attemptId: attempt.attemptId,
      data: Buffer.from(JSON.stringify({ message: code, retryable: false, type: 'response.error' }))
        .toString('base64url'),
      dispatchFence, final: true, sequence: this.nextFrameSequence(attempt.attemptId),
    })
  }

  private async submitReceipt(receipt: JournalResultReceipt): Promise<void> {
    if (!sameExecutorInferenceSource(receipt.result.inferenceSource, this.dependencies.coordinator.inferenceSource)) {
      throw new LocalInferenceReceiptError('receipt_conflict')
    }
    const apiReceipt: ApiResultReceipt = receipt
    if (receipt.result.inferenceSource?.kind === 'chatgpt') {
      if (!this.dependencies.personalReceipts) throw new DeferredPersonalReceiptError()
      try {
        const ack = await this.dependencies.personalReceipts.result(apiReceipt)
        if (ack.acknowledged !== true) throw new DeferredPersonalReceiptError()
      } catch { throw new DeferredPersonalReceiptError() }
    } else {
      try {
        const ack = await this.dependencies.transport.result(apiReceipt)
        if (ack.acknowledged !== true) throw new DeferredPersonalReceiptError()
      } catch (error) {
        if (!(error instanceof LocalInferenceApiError) || error.code !== 'LOCAL_ATTEMPT_FENCED') throw error
      }
    }
    await this.dependencies.journal.acknowledge(receipt)
  }

  /** Historical receipts can settle while the live profile is paused, revoked or stopped. */
  async reconcileReceipts(): Promise<void> {
    for (const receipt of await this.dependencies.journal.pending()) {
      try { await this.submitReceipt(receipt) }
      catch (error) { if (!(error instanceof DeferredPersonalReceiptError)) throw error }
    }
    await this.flushTerminations()
  }

  async syncResource(action?: 'pause' | 'resume'): Promise<void> {
    const coordinator = this.dependencies.coordinator
    const current = await coordinator.control()
    const requestedAction = action ?? current.pendingAction ?? undefined
    const attachment = {
      ...(coordinator.inferenceSource ? { inferenceSource: coordinator.inferenceSource } : {}),
      connectionEpoch: this.dependencies.identity.connectionEpoch, hostId: this.dependencies.identity.hostId,
      organizationId: this.dependencies.identity.organizationId, publicKey: coordinator.identity.publicKey,
    }
    const control = await this.dependencies.transport.attachResource({
      attachment: {
        ...attachment, signature: signLocalInferenceResourceAttachment(attachment, coordinator.identity.privateKey),
      },
      controlRevision: current.controlRevision, healthReason: await coordinator.healthReason(), paused: current.paused,
      ...(requestedAction ? { action: requestedAction } : {}),
    })
    await coordinator.syncControl(LocalInferenceResourceControlSchema.parse(control), requestedAction)
    await this.flushTerminations()
  }

  private async flushTerminations(): Promise<void> {
    try {
      await this.dependencies.coordinator.flushTerminations(async (termination) => {
        if (termination.inferenceSource?.kind === 'chatgpt') {
          if (!this.dependencies.personalReceipts) throw new DeferredPersonalReceiptError()
          try {
            const ack = await this.dependencies.personalReceipts.termination(termination)
            if (ack.acknowledged !== true) throw new DeferredPersonalReceiptError()
          } catch { throw new DeferredPersonalReceiptError() }
        } else {
          const ack = await this.dependencies.transport.terminate(termination)
          if (ack.acknowledged !== true) throw new DeferredPersonalReceiptError()
        }
      })
    } catch (error) {
      // Cloud transport capacity is separate from pending receipt delivery. Native mutation/barrier
      // failures still propagate; only a failed receipt submission can defer without deleting intent.
      if (!(error instanceof DeferredPersonalReceiptError)) throw error
    }
  }

  private async selectedModel(attempt: LocalInferenceAttemptRequest): Promise<EligibleModel | undefined> {
    const inventory = this.dependencies.backend
      ? { models: await this.dependencies.backend.observe() }
      : await observeOllamaInventory(this.dependencies.origin, this.dependencies.fetchImpl)
    if (attempt.inferenceSource?.kind === 'chatgpt' && this.dependencies.backend) {
      // Only an explicitly composed source backend can match cloud inventory. Direct Ollama stays physical.
      if (!sameExecutorInferenceSource(attempt.inferenceSource,
        this.dependencies.coordinator.inferenceSource)) return undefined
      return inventory.models.find(model => model.inferenceSource?.kind === 'chatgpt'
        && sameExecutorInferenceSource(model.inferenceSource, attempt.inferenceSource)
        && model.name === attempt.modelName && model.manifestDigest === attempt.modelDigest
        && model.remoteHost === null && model.remoteModel === null)
    }
    return inventory.models.find((model) => matchesSelectedModel(model, attempt))
  }

  private isCurrentLease(attempt: LocalInferenceAttemptRequest): boolean {
    try {
      return attempt.hostId === this.dependencies.identity.hostId
        && BigInt(attempt.hostEpoch) === BigInt(this.dependencies.identity.connectionEpoch)
    } catch {
      return false
    }
  }

  private nextFrameSequence(attemptId: string): number {
    const next = this.#frameSequences.get(attemptId)
    if (next === undefined) throw new Error('No active local inference frame sequence.')
    this.#frameSequences.set(attemptId, next + 1)
    return next
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }
}
