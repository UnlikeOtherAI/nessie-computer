import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalExecutorJson, ExecutorChatgptContextSchema, ExecutorInferenceSourceSchema,
  LocalInferenceResourceAdmissionSchema, LocalInferenceTerminationSchema,
  PersonalInferenceAuthoritySchema, personalInferenceAuthorityDecision,
  PersonalInferenceReceiptStatusSchema,
  type ExecutorChatgptContext, type ExecutorInferenceSource } from '@nessie/executor-protocol'
import { signLocalInferenceEnvelope } from '@nessie/local-inference-host'
import type { PersonalReceiptTransport, PersonalReceiptAttempt } from './local-inference-host.js'
import type { LocalInferenceReceiptStorage } from './local-inference-receipts.js'
import { createLocalInferenceDaemonApi } from './local-inference-api.js'
import type { LocalInferenceResultReceipt } from './local-inference-api.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import { assertOwnerOnlyStatePath, type StateSecurityDeps } from './state-security.js'
import type { PersonalStateMutation } from './personal-state-mutation.js'
import { chatgptBytesDigest } from './chatgpt-profile-store.js'
import type { ChatgptProfileKey } from './chatgpt-profile-key.js'
import { chatgptCompanionFingerprint } from './chatgpt-profile-authority.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

// Four worst-case 512KiB results fit the native 4MiB mutation ceiling after
// AES/base64 overhead. Reserve BEFORE accept; never evict unresolved outcomes.
const CAPACITY = 4
const positive = z.number().int().positive()
const epoch = z.string().regex(/^[1-9][0-9]{0,18}$/u)
const AttemptSchema = z.object({ attemptId: z.string().uuid(), hostId: z.string().uuid(), hostEpoch: positive,
  runId: z.string().uuid(), runFence: z.string().min(1).max(160), invocationId: z.string().min(1).max(160),
  bindingId: z.string().uuid(), bindingRevision: positive, modelName: z.string().min(1).max(200),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/u), inferenceSource: ExecutorInferenceSourceSchema,
  personalAuthority: PersonalInferenceAuthoritySchema }).strict()
const HostSchema = z.object({ hostId: z.string().uuid(), organizationId: z.string().uuid(),
  connectionEpoch: epoch, executorConnectionEpoch: epoch }).strict()
const RecordSchema = z.object({ attempt: AttemptSchema, dispatchFence: positive, host: HostSchema,
  admission: LocalInferenceResourceAdmissionSchema,
  publicKeyFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u), resultKnownAck: z.boolean(),
  invocationPrepared: z.boolean(), preProviderClosed: z.boolean(),
  resultAckDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  terminationDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable() }).strict()
const StateSchema = z.object({ version: z.literal(2),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  records: z.array(RecordSchema).max(1024) }).strict()
type State = z.infer<typeof StateSchema>
const fail: () => never = () => { throw new PersonalInferenceProtectionError('chatgpt_receipt_custody_unavailable') }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** One profile actor holds profile-runtime.lock for this journal's entire lifetime. */
export class ChatgptReceiptCustody {
  readonly directory: string
  readonly storage: LocalInferenceReceiptStorage
  private readonly receiptStatus: ReturnType<typeof createLocalInferenceDaemonApi>['receiptStatus']
  readonly transport: PersonalReceiptTransport & {
    prepareInvocation: (input: { attemptId: string; dispatchFence: number }) => Promise<void>
  }
  constructor(private readonly input: {
    mutation: PersonalStateMutation; context: ExecutorChatgptContext; key: ChatgptProfileKey
    accountGeneration: number; consentRevision: number
    /** Fresh local permission is required for new background origins, never historical receipts. */
    backgroundConsentRevision?: () => Promise<number | null>
    /** Real durable journal/coordinator absence, never an elapsed-time verdict. */
    canForget: (attemptId: string) => Promise<boolean>
    /** Explicit deterministic transport/state fixtures; production uses pinned HTTPS/native security. */
    api?: Pick<ReturnType<typeof createLocalInferenceDaemonApi>, 'resultReceipt' | 'terminationReceipt'>
      & Partial<Pick<ReturnType<typeof createLocalInferenceDaemonApi>, 'receiptStatus'>>
    security?: StateSecurityDeps
  }) {
    const context = ExecutorChatgptContextSchema.parse(input.context)
    if (input.key.profileId !== context.profileId || chatgptCompanionFingerprint(input.key)
      !== context.publicKeyFingerprint || !positive.safeParse(input.accountGeneration).success
      || !positive.safeParse(input.consentRevision).success) fail()
    this.directory = join(input.mutation.root, 'profiles', context.profileId, 'receipts',
      String(input.accountGeneration), String(input.consentRevision))
    const api = input.api ?? createLocalInferenceDaemonApi({ apiBaseUrl: context.principal.serverOrigin })
    this.receiptStatus = api.receiptStatus ?? (async () => fail())
    this.storage = {
      read: async () => {
        const value = await this.read('results.json')
        return value === null ? undefined : JSON.parse(value.toString('utf8'))
      },
      write: async value => this.mutate(async () => { await this.replace('results.json', value) }),
      remove: async () => this.mutate(async () => {
        const prior = await this.read('results.json')
        if (prior) await input.mutation.mutate(join(this.directory, 'results.json'), {
          operation: 'delete', expectedDigest: chatgptBytesDigest(prior),
        })
        await input.mutation.barrier(this.directory)
      }),
    }
    this.transport = {
      prepareInvocation: async invocation => this.mutate(async () => {
        const state = await this.state()
        const original = state.records.find(record => record.attempt.attemptId === invocation.attemptId)
        if (!original || original.dispatchFence !== invocation.dispatchFence || original.preProviderClosed
          || original.resultAckDigest !== null || original.terminationDigest !== null) return fail()
        await this.replace('origins.json', { ...state, records: state.records.map(record =>
          record === original ? { ...record, invocationPrepared: true } : record) })
      }),
      retainAttempt: async incoming => {
        // Journal persistence takes its serial lock before this directory
        // lock. Never invert that order by querying the journal while held.
        const absent = await this.absentRecords()
        return this.mutate(async () => {
        const state = await this.state()
        const candidate = RecordSchema.parse({ ...incoming, publicKeyFingerprint: context.publicKeyFingerprint,
          resultKnownAck: false, resultAckDigest: null, terminationDigest: null,
          invocationPrepared: false, preProviderClosed: false })
        const source = candidate.attempt.inferenceSource
        if (source.kind !== 'chatgpt' || source.profileId !== context.profileId
          || source.accountGeneration !== input.accountGeneration || source.consentRevision !== input.consentRevision
          || candidate.attempt.personalAuthority.runId !== candidate.attempt.runId
          || candidate.host.hostId !== context.hostId || candidate.attempt.hostId !== context.hostId
          || candidate.host.connectionEpoch !== context.hostConnectionEpoch
          || candidate.attempt.hostEpoch !== Number(context.hostConnectionEpoch)
          || candidate.host.executorConnectionEpoch !== context.connectionEpoch
          || candidate.host.organizationId !== context.principal.organizationId
          || canonicalExecutorJson(candidate.attempt.personalAuthority.principal)
            !== canonicalExecutorJson(context.principal)
          || canonicalExecutorJson(candidate.admission.inferenceSource) !== canonicalExecutorJson(source)) return fail()
        const backgroundRevision = candidate.attempt.personalAuthority.origin.kind === 'background'
          ? await input.backgroundConsentRevision?.() ?? null : null
        if (!personalInferenceAuthorityDecision(candidate.attempt.personalAuthority, context.principal,
          backgroundRevision).allowed) {
          return fail()
        }
        const old = state.records.find(record => record.attempt.attemptId === candidate.attempt.attemptId)
        if (old) {
          if (canonicalExecutorJson({ ...old, resultKnownAck: false, resultAckDigest: null, terminationDigest: null,
            invocationPrepared: false, preProviderClosed: false })
            !== canonicalExecutorJson(candidate)) return fail()
          return
        }
        const records = []
        let pending = 0
        for (const record of state.records) {
          const settled = absent.get(record.attempt.attemptId) === canonicalExecutorJson(record)
          // Exact ACKs plus outbox absence release local custody even when
          // server usage remains unknown. Never expire unacknowledged work.
          if (!settled) pending += 1
          if (!settled) records.push(record)
        }
        if (pending >= CAPACITY || records.length >= 1024) return fail()
        await this.replace('origins.json', { ...state, records: [...records, candidate] })
        })
      },
      result: async receipt => {
        const retained = await this.envelope(receipt.attemptId, 'result', receipt, record => {
          if (record.dispatchFence !== receipt.dispatchFence
            || canonicalExecutorJson(record.attempt.inferenceSource)
              !== canonicalExecutorJson(receipt.result.inferenceSource)
            || record.attempt.modelDigest !== receipt.result.modelDigest
            || receipt.result.capability.model !== record.attempt.modelName
            || receipt.result.capability.provider !== 'executor/chatgpt') return fail()
        })
        const acknowledged = await api.resultReceipt({ envelope: retained, receipt })
        const known = receipt.result.personalNonacceptance !== undefined
          || receipt.result.usage.inputTokens !== null && receipt.result.usage.outputTokens !== null
        await this.mark(receipt.attemptId, record => ({ ...record, resultKnownAck: known,
          resultAckDigest: chatgptBytesDigest(Buffer.from(canonicalExecutorJson(receipt.result))) }))
        return acknowledged
      },
      termination: async value => {
        let termination = LocalInferenceTerminationSchema.parse(value)
        await this.mutate(async () => {
          const state = await this.state()
          const original = state.records.find(record => record.attempt.attemptId === termination.attemptId)
          if (!original || canonicalExecutorJson(original.admission) !== canonicalExecutorJson({
            admissionId: termination.admissionId, resourceId: termination.resourceId,
            fence: termination.fence, inferenceSource: termination.inferenceSource,
          })) return fail()
          if (!original.invocationPrepared) {
            // Close the producer stage before claiming nondispatch. A live
            // concurrent invocation cannot pass the same native CAS fence.
            await this.replace('origins.json', { ...state, records: state.records.map(record =>
              record === original ? { ...record, preProviderClosed: true } : record) })
            termination = { ...termination, confirmed: true }
          }
        })
        const envelope = await this.envelope(termination.attemptId, 'termination', termination, record => {
          if (canonicalExecutorJson(record.admission) !== canonicalExecutorJson({ admissionId: termination.admissionId,
            resourceId: termination.resourceId, fence: termination.fence,
            inferenceSource: termination.inferenceSource })) {
            return fail()
          }
        })
        const acknowledged = await api.terminationReceipt({ envelope, termination })
        await this.mark(termination.attemptId, record => ({ ...record,
          terminationDigest: chatgptBytesDigest(Buffer.from(canonicalExecutorJson(termination))) }))
        return acknowledged
      },
    }
  }

  async open(): Promise<void> {
    await this.input.mutation.ensureDirectory(this.directory)
    await this.input.mutation.barrier(this.directory)
    await this.mutate(() => this.replace('context.json', this.input.context))
  }
  async assertInvocationPrepared(attempt: PersonalReceiptAttempt): Promise<void> {
    const { attemptId, hostId, hostEpoch, runId, runFence, invocationId, bindingId, bindingRevision,
      modelName, modelDigest, inferenceSource, personalAuthority } = attempt
    await this.mutate(async () => {
      const original = (await this.state()).records.find(record => record.attempt.attemptId === attemptId)
      if (!original?.invocationPrepared || original.preProviderClosed || original.resultAckDigest
        || original.terminationDigest || canonicalExecutorJson(original.attempt) !== canonicalExecutorJson({
          attemptId, hostId, hostEpoch, runId, runFence, invocationId, bindingId, bindingRevision,
          modelName, modelDigest, inferenceSource, personalAuthority,
        })) return fail()
    })
  }
  /** Positive actor stop/native admission precedes this reserved-outcome reconstruction. */
  async recoveryReceipt(reservation: {
    attemptId: string; dispatchFence: number; inferenceSource: ExecutorInferenceSource
  }): Promise<LocalInferenceResultReceipt> {
    return this.mutate(async () => {
      const state = await this.state()
      const original = state.records.find(record => record.attempt.attemptId === reservation.attemptId)
      if (!original || original.dispatchFence !== reservation.dispatchFence
        || canonicalExecutorJson(original.attempt.inferenceSource)
          !== canonicalExecutorJson(reservation.inferenceSource)) return fail()
      if (!original.invocationPrepared) {
        await this.replace('origins.json', { ...state, records: state.records.map(record =>
          record === original ? { ...record, preProviderClosed: true } : record) })
      }
      return { attemptId: reservation.attemptId, dispatchFence: reservation.dispatchFence, result: {
        inferenceSource: original.attempt.inferenceSource, modelDigest: original.attempt.modelDigest,
        content: null, finishReason: 'error', toolCalls: [], usage: { inputTokens: null, outputTokens: null },
        remoteHost: null, remoteModel: null,
        ...(!original.invocationPrepared ? { personalNonacceptance: { kind: 'not_sent' as const } } : {}),
        capability: { discoveredAt: new Date().toISOString(), model: original.attempt.modelName,
          provider: 'executor/chatgpt', source: 'manual', structuredOutputMode: 'text-only',
          supportsChat: true, supportsEmbeddings: false, supportsModelDiscovery: false, supportsStreaming: false,
          supportsVision: false, systemPromptMode: 'native', toolCallingMode: 'disabled',
          toolResultMode: 'native-tool-message', usageReporting: { cachedInputTokens: false,
            cachedOutputTokens: false, cacheReadTokens: false, cacheWriteTokens: false,
            inputTokens: false, outputTokens: false, providerReportedCost: false } },
      } }
    })
  }
  /**
   * Repair an earlier live ACK that retired its journal before custody recorded
   * the acknowledgement. Only a stopped actor with actual outbox absence may
   * ask the original server for its retained result digest; no result replay.
   */
  async reconcileAcknowledgements(): Promise<void> {
    for (const original of (await this.state()).records) {
      if (original.resultAckDigest && original.terminationDigest
        || !await this.input.canForget(original.attempt.attemptId)) continue
      if (!original.resultAckDigest) {
        const receipt = await this.recoveryReceipt({ attemptId: original.attempt.attemptId,
          dispatchFence: original.dispatchFence, inferenceSource: original.attempt.inferenceSource })
        const envelope = await this.envelope(receipt.attemptId, 'result', receipt, record => {
          if (record.dispatchFence !== original.dispatchFence
            || canonicalExecutorJson(record.attempt) !== canonicalExecutorJson(original.attempt)) return fail()
        })
        // This body authenticates only the read. It never becomes a substitute
        // outcome, never reports usage and never opens provider access.
        const proof = PersonalInferenceReceiptStatusSchema.parse(await this.receiptStatus({ envelope, receipt }))
        if (!proof.resultDigest) continue
        await this.mark(original.attempt.attemptId, record => {
          if (canonicalExecutorJson(record.attempt) !== canonicalExecutorJson(original.attempt)
            || record.dispatchFence !== original.dispatchFence
            || record.resultAckDigest && record.resultAckDigest !== proof.resultDigest) return fail()
          return { ...record, resultAckDigest: proof.resultDigest }
        })
      }
      if (!original.terminationDigest) {
        // Prepared provider work remains unconfirmed. An exact historical ACK
        // releases only local transport custody, never invents provider stop.
        await this.transport.termination({ ...original.admission,
          attemptId: original.attempt.attemptId, confirmed: false })
      }
    }
  }
  /** Usage may remain unknown on the server; this only proves local outbox ACKs. */
  async settled(): Promise<boolean> {
    const absent = await this.absentRecords()
    return this.mutate(async () => (await this.state()).records.every(record =>
      absent.get(record.attempt.attemptId) === canonicalExecutorJson(record)))
  }
  static async historicalContext(directory: string): Promise<ExecutorChatgptContext> {
    const path = join(directory, 'context.json')
    await assertOwnerOnlyStatePath(path, 'file')
    const bytes = await readFile(path)
    if (bytes.length > 16 * 1024) return fail()
    return ExecutorChatgptContextSchema.parse(JSON.parse(bytes.toString('utf8')))
  }
  /** Public finalizer reads only scope/ACK metadata, never encrypted outputs or keys. */
  static async assertCleared(directory: string, capacity: string, mutation: PersonalStateMutation): Promise<void> {
    for (const path of [join(directory, 'results.json'), join(capacity, 'resource-key.json')]) {
      try { await lstat(path); return fail() }
      catch (error) { if (!missing(error)) throw error }
    }
    for (const path of [directory, capacity]) {
      try {
        await assertOwnerOnlyStatePath(path, 'directory')
        await mutation.barrier(path)
        if ((await readdir(path)).some(name => /^termination-.*\.json$/u.test(name))) return fail()
      } catch (error) { if (!missing(error)) throw error }
    }
    // Recheck after native writer reconciliation and its namespace barrier;
    // pre-barrier absence cannot authorize a delayed writer's publication.
    for (const path of [join(directory, 'results.json'), join(capacity, 'resource-key.json')]) {
      try { await lstat(path); return fail() }
      catch (error) { if (!missing(error)) throw error }
    }
    try {
      const path = join(directory, 'origins.json')
      await assertOwnerOnlyStatePath(path, 'file')
      const bytes = await readFile(path)
      if (bytes.length > 4 * 1024 * 1024) return fail()
      const state = StateSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (state.records.some(record => !record.resultAckDigest || !record.terminationDigest)) return fail()
    } catch (error) { if (!missing(error)) throw error }
  }
  private async read(name: string): Promise<Buffer | null> {
    try {
      const path = join(this.directory, name)
      await assertOwnerOnlyStatePath(path, 'file', this.input.security)
      const bytes = await readFile(path)
      if (bytes.length > 4 * 1024 * 1024) return fail()
      return bytes
    } catch (error) { if (missing(error)) return null; throw error }
  }
  private async replace(name: string, value: unknown): Promise<void> {
    const prior = await this.read(name)
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
    await this.input.mutation.mutate(join(this.directory, name), { operation: 'replace', bytes,
      expectedDigest: prior ? chatgptBytesDigest(prior) : null })
  }
  private async state(): Promise<State> {
    const prior = await this.read('origins.json')
    return prior ? StateSchema.parse(JSON.parse(prior.toString('utf8'))) : { version: 2, sequence: 0, records: [] }
  }
  private async absentRecords(): Promise<Map<string, string>> {
    const absent = new Map<string, string>()
    for (const record of (await this.state()).records) {
      if (record.resultAckDigest && record.terminationDigest
        && await this.input.canForget(record.attempt.attemptId)) {
        absent.set(record.attempt.attemptId, canonicalExecutorJson(record))
      }
    }
    return absent
  }
  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const lock = await acquireOwnerStateLock(this.directory, 'mutation.lock', { security: this.input.security })
    try { return await work() } finally { await lock.release() }
  }
  private async mark(
    attemptId: string, change: (record: z.infer<typeof RecordSchema>) => z.infer<typeof RecordSchema>,
  ): Promise<void> {
    await this.mutate(async () => {
      const state = await this.state()
      if (!state.records.some(record => record.attempt.attemptId === attemptId)) return fail()
      await this.replace('origins.json', { ...state, records: state.records.map(record =>
        record.attempt.attemptId === attemptId ? change(record) : record) })
    })
  }
  private async envelope(attemptId: string, purpose: 'result' | 'termination', body: unknown,
    validate: (record: z.infer<typeof RecordSchema>) => void) {
    return this.mutate(async () => {
      const state = await this.state()
      const record = state.records.find(candidate => candidate.attempt.attemptId === attemptId)
      if (!record || record.publicKeyFingerprint !== this.input.context.publicKeyFingerprint) return fail()
      validate(record)
      const sequence = state.sequence + 1
      if (!Number.isSafeInteger(sequence)) return fail()
      await this.replace('origins.json', { ...state, sequence })
      return signLocalInferenceEnvelope({ body, machinePrivateKey: this.input.key.privateKey, header: {
        protocolVersion: 1, purpose, sentAt: new Date().toISOString(), sequence, ...record.host,
      } })
    })
  }
}
