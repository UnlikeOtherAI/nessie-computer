import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionSecretPlanCandidateSchema, T3ExecutionGraphPayloadSchema,
  T3ExecutionSecretReadAdmissionSchema, T3ExecutionSecretReadPreparationPayloadSchema,
  T3ExecutionSignedAdmissionSchema, T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN,
  type T3ExecutionSecretPlanCandidate, type T3ExecutionReceipt, type T3ExecutionSignedAdmission,
  type T3ExecutionSecretReadAdmission, type ExecutorT3LaneDelivery }
  from '@nessie/executor-protocol/t3-session'
import { CodexSettings, ClaudeSettings, ProviderInstanceConfig, ServerSettings,
  type ResolvedProviderInstanceEnvironment }
  from '@nessie/t3-session-source/contracts'
import { ProviderSecretPlan, Settings, SelectedProvider, SelectedCodex, SelectedClaude,
  ProviderDirectory, OriginalCodexFactory, OriginalClaudeRunner, Adapters }
  from '@nessie/t3-session-source/engine'
import type { T3ExecutionResourceScope } from '../source/execution.js'
import { readSessionExecutionResources, type SessionExecutionResourcesEffect } from './execution-resources.js'
import type { PreparedSessionLaunchTarget } from './launch-target.js'
import type { EffectFailure, EffectServices } from './effect-types.js'
import type { ScopedSessionSecretReadAttempts } from './secret-read-attempts.js'
import { verifyProtectedT3SecretDelivery, protectedT3SecretInstalledFrame } from '../../t3-protected-process.js'
import { snapshotT3LaneDelivery } from '../../t3-session-delivery.js'
import { joinedNativeEffect } from './native-effect.js'
import type { ReservedSessionLaunch } from './native-launch.js'
import { makeSessionCodexClientFactory } from './codex-factory.js'
import { makeSessionClaudeQueryRunner, type SessionClaudeHistoryOwner } from './claude-factory.js'

const sha = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')
const bytesSha = (value: string) => 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex')
export class SessionSecretPlanRefused extends Error {
  constructor() { super('T3_SESSION_SECRET_PLAN_REFUSED'); this.name = 'SessionSecretPlanRefused' }
}
export interface SessionProviderSecretPlanEvidence {
  readonly resourceId: string
  readonly resourceGeneration: string
  readonly settingsDigest: string
  readonly settingsIdentity: ReturnType<typeof settingsIdentity>
  readonly providerInstanceId: string
  readonly providerConfigDigest: string
  readonly secretProvidersDigest: string
  readonly credentialHomeReferenceId: string
  readonly recipient: EffectValue['receipt']['custody']
  readonly selection: ProviderSecretPlan.ProviderInstanceSecretPlan
}
// Keep the actual source receipt type rather than a separately authored identity DTO.
const settingsIdentity = (bound: EffectValue) => bound.receipt.evidence.settingsIdentity
type EffectValue = SessionExecutionResourcesEffect extends Effect.Effect<infer A, infer _E, infer _R> ? A : never
type PlanEffect = Effect.Effect<HeldSessionProviderSecretPlan,
  SessionSecretPlanRefused | EffectFailure<SessionExecutionResourcesEffect>,
  EffectServices<SessionExecutionResourcesEffect> | Scope.Scope>
type Record = { source: T3ExecutionResourceScope; target: PreparedSessionLaunchTarget;
  evidence: SessionProviderSecretPlanEvidence; settings: string; entry: ProviderInstanceConfig;
  environment: Array<ResolvedProviderInstanceEnvironment[number] | undefined>; stop: AbortController;
  pending: Set<Promise<void>>; lifetimes: Map<AbortSignal, () => void>; constructed: boolean }
const records = new WeakMap<HeldSessionProviderSecretPlan, Record>()
const token = Object.freeze({})

function retainSecretLifetime(record: Record, signal: AbortSignal): void {
  if (record.lifetimes.has(signal)) return
  const revoke = () => { record.environment.fill(undefined); record.stop.abort() }
  record.lifetimes.set(signal, revoke)
  signal.addEventListener('abort', revoke, { once: true })
  if (signal.aborted) revoke()
}

/** Non-hydrating selection only. A service must independently bind these
 * original slots to its held settings/recipient before it can sign a read plan.
 * This object cannot release a secret or serve as a preparation-effect grant. */
export class HeldSessionProviderSecretPlan {
  private constructor(key: object, record: Record) {
    if (key !== token) throw new SessionSecretPlanRefused()
    records.set(this, record)
    Object.freeze(this)
  }
  get evidence(): SessionProviderSecretPlanEvidence {
    const record = records.get(this)
    if (!record) throw new SessionSecretPlanRefused()
    return structuredClone(record.evidence)
  }
  /** Exact parent-integrated native candidate. Empty selection needs no read;
   * this getter neither hydrates nor consumes a slot. */
  get candidate(): T3ExecutionSecretPlanCandidate {
    const { selection, recipient, ...evidence } = this.evidence
    try {
      return T3ExecutionSecretPlanCandidateSchema.parse({ evidence: { ...evidence, custody: recipient }, selection })
    }
    catch { throw new SessionSecretPlanRefused() }
  }
  static readonly prepare = (source: T3ExecutionResourceScope, target: PreparedSessionLaunchTarget): PlanEffect =>
    Effect.gen(function* () {
      const bound = yield* readSessionExecutionResources(source, target)
      const settings = yield* (yield* Settings.ServerSettingsReadService).getSettings
      const entry = Object.hasOwn(settings.providerInstances, target.providerInstanceId)
        ? settings.providerInstances[target.providerInstanceId] : undefined
      if (!entry || entry.driver !== target.driverKind) return yield* Effect.fail(new SessionSecretPlanRefused())
      const schema = target.driverKind === 'codex' ? CodexSettings : ClaudeSettings
      const selection = ProviderSecretPlan.planProviderInstanceSecrets(schema, entry)
      // Only references and slot identities are exposed. Literal settings and
      // secret provider configuration stay inside this protected callback.
      const evidence: SessionProviderSecretPlanEvidence = {
        resourceId: bound.receipt.resourceId, resourceGeneration: bound.receipt.resourceGeneration,
        settingsDigest: bound.receipt.evidence.settingsDigest, settingsIdentity: settingsIdentity(bound),
        providerInstanceId: target.providerInstanceId,
        providerConfigDigest: sha(Schema.encodeSync(ProviderInstanceConfig)(entry)),
        secretProvidersDigest: sha(Schema.encodeSync(ServerSettings)(settings).secretProviders),
        credentialHomeReferenceId: bound.credentialBindingId, recipient: bound.receipt.custody,
        selection: structuredClone(selection),
      }
      const plan = new HeldSessionProviderSecretPlan(token, { source, target, evidence,
        settings: canonicalExecutorJson(Schema.encodeSync(ServerSettings)(settings)),
        entry: structuredClone(entry), stop: new AbortController(), pending: new Set(), lifetimes: new Map(),
        constructed: false,
        environment: (entry.environment ?? []).map(variable =>
          ProviderSecretPlan.resolveProviderEnvironmentVariable(variable, undefined)) })
      yield* readSessionExecutionResources(source, target)
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        const record = records.get(plan)
        if (record) {
          record.stop.abort()
          await Promise.allSettled([...record.pending])
          record.environment.fill(undefined)
          for (const [signal, revoke] of record.lifetimes) signal.removeEventListener('abort', revoke)
          record.lifetimes.clear()
        }
        records.delete(plan)
      }))
      return plan
    })
}

/** Escaped plans and any settings/source/recipient replacement fail closed. */
export const recheckSessionProviderSecretPlan = (plan: HeldSessionProviderSecretPlan): Effect.Effect<void,
  SessionSecretPlanRefused | EffectFailure<SessionExecutionResourcesEffect>,
  EffectServices<SessionExecutionResourcesEffect>> => Effect.gen(function* () {
  const record = records.get(plan)
  if (!record || record.stop.signal.aborted) return yield* Effect.fail(new SessionSecretPlanRefused())
  const bound = yield* readSessionExecutionResources(record.source, record.target)
  const settings = yield* (yield* Settings.ServerSettingsReadService).getSettings
  if (bound.receipt.resourceId !== record.evidence.resourceId
    || bound.receipt.resourceGeneration !== record.evidence.resourceGeneration
    || canonicalExecutorJson(bound.receipt.custody) !== canonicalExecutorJson(record.evidence.recipient)
    || canonicalExecutorJson(Schema.encodeSync(ServerSettings)(settings)) !== record.settings) {
    return yield* Effect.fail(new SessionSecretPlanRefused())
  }
})

type SelectedRegistry = ProviderDirectory.ProviderInstanceRegistry['Service']
type SelectedInstanceInput = Pick<Parameters<typeof SelectedProvider.makeSelectedProviderInstance>[0],
  'instanceId' | 'entry' | 'secrets' | 'managedPolicy'>
type SelectedProviderError = SessionSecretPlanRefused | EffectFailure<SessionExecutionResourcesEffect>
type SelectedProviderBase = EffectServices<SessionExecutionResourcesEffect>
  | Settings.ServerSettingsService | Scope.Scope
type SelectedCodexHost = Exclude<SelectedCodex.SelectedCodexDriverEnv,
  OriginalCodexFactory.CodexAppServerClientFactory>
type SelectedClaudeHost = Exclude<SelectedClaude.SelectedClaudeDriverEnv,
  OriginalClaudeRunner.ClaudeAgentSdkQueryRunner>

/** The private plan owns the only value consumer. Both original constructors
 * share these target/settings/lifetime checks without exposing environment
 * values or requiring the other driver's host services. */
const constructSelectedProvider = <A, R>(plan: HeldSessionProviderSecretPlan, launch: ReservedSessionLaunch,
  driver: 'codex' | 'claudeAgent', construct: (input: SelectedInstanceInput) => Effect.Effect<A, never, R>):
  Effect.Effect<A, SelectedProviderError, SelectedProviderBase | R> =>
  Effect.gen(function* () {
    yield* recheckSessionProviderSecretPlan(plan)
    const record = records.get(plan)
    if (!record || record.constructed || record.target !== launch.target || launch.signal.aborted
      || record.target.driverKind !== driver
      || record.evidence.selection.references.length !== 0
      || record.environment.some(variable => variable === undefined)) {
      return yield* Effect.fail(new SessionSecretPlanRefused())
    }
    record.constructed = true // Failed or interrupted construction cannot reread/rebuild this plan.
    const settingsService = yield* Settings.ServerSettingsService
    const currentSettings = yield* settingsService.getSettings
    const managedPolicy = structuredClone(settingsService.managedPolicy)
    if (canonicalExecutorJson(Schema.encodeSync(ServerSettings)(currentSettings)) !== record.settings) {
      return yield* Effect.fail(new SessionSecretPlanRefused())
    }
    retainSecretLifetime(record, launch.signal)
    retainSecretLifetime(record, record.source.signal)
    const environment = record.environment.filter(
      (variable): variable is ResolvedProviderInstanceEnvironment[number] => variable !== undefined)
    const registry = yield* construct({ instanceId: record.target.providerInstanceId,
      entry: record.entry, secrets: { environment, config: [] }, managedPolicy })
    yield* recheckSessionProviderSecretPlan(plan)
    const after = yield* settingsService.getSettings
    if (canonicalExecutorJson(Schema.encodeSync(ServerSettings)(after)) !== record.settings
      || canonicalExecutorJson(settingsService.managedPolicy ?? null)
        !== canonicalExecutorJson(managedPolicy ?? null)) {
      return yield* Effect.fail(new SessionSecretPlanRefused())
    }
    if (launch.signal.aborted) return yield* Effect.fail(new SessionSecretPlanRefused())
    return registry
  })

/** Codex retains its original independent host requirements. Nonempty plans
 * still require the safe native read producer before any selected constructor. */
export const createSessionSelectedProvider = (plan: HeldSessionProviderSecretPlan, launch: ReservedSessionLaunch):
  Effect.Effect<SelectedRegistry, SelectedProviderError, SelectedProviderBase | SelectedCodexHost> =>
  constructSelectedProvider(plan, launch, 'codex', input => Effect.gen(function* () {
    const factory = yield* makeSessionCodexClientFactory(launch)
    return yield* SelectedProvider.makeSelectedProviderInstance({ ...input, driver: SelectedCodex.SelectedCodexDriver })
      .pipe(Effect.provideService(OriginalCodexFactory.CodexAppServerClientFactory, factory))
  }))

/** Claude requires an actual admitted history owner; no SDK/default fallback.
 * Its query runner stays in the same original plan/launch scope. */
export const createSessionSelectedClaudeProvider = (plan: HeldSessionProviderSecretPlan,
  launch: ReservedSessionLaunch, history: SessionClaudeHistoryOwner):
  Effect.Effect<SelectedRegistry, SelectedProviderError, SelectedProviderBase | SelectedClaudeHost> =>
  Effect.suspend(() => history ? constructSelectedProvider(plan, launch, 'claudeAgent', input =>
    Effect.gen(function* () {
      const runner = yield* makeSessionClaudeQueryRunner(launch, history)
      return yield* SelectedProvider.makeSelectedProviderInstance({ ...input,
        driver: SelectedClaude.SelectedClaudeDriver })
        .pipe(Effect.provideService(OriginalClaudeRunner.ClaudeAgentSdkQueryRunner, runner))
    })) : Effect.fail(new SessionSecretPlanRefused()))

/** The original execution registry uses only actual adapter/identity/auth fields.
 * Snapshot and text-generation construction remains with its owning capability. */
export const createSessionSelectedCodexAdapters = (plan: HeldSessionProviderSecretPlan,
  launch: ReservedSessionLaunch, hooks: Omit<SelectedCodex.SelectedCodexExecutionHooks, 'instanceId'>):
  Effect.Effect<Adapters.ProviderAdapterRegistryV2Shape, SelectedProviderError, SelectedProviderBase |
    Exclude<SelectedCodex.SelectedCodexExecutionEnv, OriginalCodexFactory.CodexAppServerClientFactory>> =>
  constructSelectedProvider(plan, launch, 'codex', input => Effect.gen(function* () {
    const factory = yield* makeSessionCodexClientFactory(launch)
    const directory = yield* SelectedProvider.makeSelectedExecutionProvider({ ...input,
      driver: SelectedCodex.makeSelectedCodexExecutionDriver({ ...hooks, instanceId: input.instanceId }) }).pipe(
      Effect.provideService(OriginalCodexFactory.CodexAppServerClientFactory, factory))
    return Adapters.fromProviderExecutionDirectory(directory)
  }))

export const createSessionSelectedClaudeAdapters = (plan: HeldSessionProviderSecretPlan,
  launch: ReservedSessionLaunch, history: SessionClaudeHistoryOwner,
  hooks: Omit<SelectedClaude.SelectedClaudeExecutionHooks, 'instanceId'>):
  Effect.Effect<Adapters.ProviderAdapterRegistryV2Shape, SelectedProviderError, SelectedProviderBase |
    Exclude<SelectedClaude.SelectedClaudeExecutionEnv, OriginalClaudeRunner.ClaudeAgentSdkQueryRunner>> =>
  Effect.suspend(() => history ? constructSelectedProvider(plan, launch, 'claudeAgent', input =>
    Effect.gen(function* () {
      const runner = yield* makeSessionClaudeQueryRunner(launch, history)
      const directory = yield* SelectedProvider.makeSelectedExecutionProvider({ ...input,
        driver: SelectedClaude.makeSelectedClaudeExecutionDriver({ ...hooks, instanceId: input.instanceId }) }).pipe(
        Effect.provideService(OriginalClaudeRunner.ClaudeAgentSdkQueryRunner, runner))
      return Adapters.fromProviderExecutionDirectory(directory)
    })) : Effect.fail(new SessionSecretPlanRefused()))

/** Begin one selected full-array slot before native observation. This only
 * makes retries terminal. No value installer or native read is exposed here. */
export const beginSessionProviderSecretRead = (plan: HeldSessionProviderSecretPlan,
  target: PreparedSessionLaunchTarget, attempts: ScopedSessionSecretReadAttempts,
  originalEnvironmentIndex: number, offered: ExecutorT3LaneDelivery): Effect.Effect<SessionProviderSecretRead,
    SessionSecretPlanRefused | EffectFailure<SessionExecutionResourcesEffect>,
    EffectServices<SessionExecutionResourcesEffect>> => Effect.gen(function* () {
  yield* recheckSessionProviderSecretPlan(plan)
  return yield* Effect.try({ try: () => {
    const record = records.get(plan)
    if (!record || record.target !== target) throw new SessionSecretPlanRefused()
    const candidate = plan.candidate
    if (!candidate.selection.environment.some(slot => slot.index === originalEnvironmentIndex)) {
      throw new SessionSecretPlanRefused()
    }
    const delivery = snapshotT3LaneDelivery(offered, target.request)
    if (!delivery.executionGraph || !delivery.provenance) throw new SessionSecretPlanRefused()
    const graph = T3ExecutionGraphPayloadSchema.parse(JSON.parse(delivery.executionGraph.payload))
    if (graph.binding.threadId !== target.threadId || graph.binding.providerInstanceId !== target.providerInstanceId
      || graph.binding.credentialBindingId !== candidate.evidence.credentialHomeReferenceId
      || canonicalExecutorJson(graph.custody) !== canonicalExecutorJson(candidate.evidence.custody)) {
      throw new SessionSecretPlanRefused()
    }
    attempts.claim(originalEnvironmentIndex)
    const read = Object.freeze({ get candidate() { return structuredClone(candidate) } }) as SessionProviderSecretRead
    reads.set(read, { plan, candidate, index: originalEnvironmentIndex, state: 'selected',
      graphNonce: graph.nonce, binding: { ...graph.binding,
        sourceEvidenceDigest: bytesSha(delivery.executionGraph.payload) } })
    return read
  }, catch: () => new SessionSecretPlanRefused() })
})

declare const readBrand: unique symbol
export interface SessionProviderSecretRead {
  readonly [readBrand]: true
  readonly candidate: T3ExecutionSecretPlanCandidate
}
type ReadRecord = { plan: HeldSessionProviderSecretPlan; candidate: T3ExecutionSecretPlanCandidate;
  index: number; graphNonce: string; binding: T3ExecutionSecretReadAdmission['binding'];
  state: 'selected' | 'receiving' | 'installed' | 'failed' }
const reads = new WeakMap<SessionProviderSecretRead, ReadRecord>()

/** Dedicated one-way value/ACK channels only. This never starts a child, obtains
 * permission, returns a value or accepts a caller-supplied installer. Native's
 * service-authenticated clearance header, not EOF, attests child clearance. */
export const receiveSessionProviderSecretRead = (read: SessionProviderSecretRead,
  preparationReceipt: T3ExecutionReceipt, exactSignedAdmission: T3ExecutionSignedAdmission,
  valueInput: Readable, ackOutput: Writable, parent: AbortSignal): Effect.Effect<void,
    SessionSecretPlanRefused | EffectFailure<SessionExecutionResourcesEffect>,
    EffectServices<SessionExecutionResourcesEffect>> => Effect.gen(function* () {
  const captured = yield* Effect.try({ try: () => {
    const slot = reads.get(read)
    if (!slot || slot.state !== 'selected') throw new SessionSecretPlanRefused()
    slot.state = 'receiving' // All later failures are terminal, including malformed authority.
    const record = records.get(slot.plan)
    if (!record || record.stop.signal.aborted) throw new SessionSecretPlanRefused()
    // The delivery deadline ends at ACK; the captured operation/source lifetime
    // still revokes installed values afterwards, until the owner scope drains.
    retainSecretLifetime(record, parent)
    retainSecretLifetime(record, record.source.signal)
    const signed = T3ExecutionSignedAdmissionSchema.parse(exactSignedAdmission)
    const admission = T3ExecutionSecretReadAdmissionSchema.parse(JSON.parse(signed.payload))
    const preparation = T3ExecutionSecretReadPreparationPayloadSchema.parse(JSON.parse(preparationReceipt.payload))
    const { issuerKeyId, preparationReceiptDigest, ...selected } = admission
    if (preparationReceipt.domain !== T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN
      || issuerKeyId !== preparationReceipt.keyId || preparationReceiptDigest !== bytesSha(preparationReceipt.payload)
      || admission.acceptedGraphNonce !== slot.graphNonce || admission.planDigest !== sha(slot.candidate)
      || canonicalExecutorJson(admission.binding) !== canonicalExecutorJson(slot.binding)
      || canonicalExecutorJson(admission.evidence) !== canonicalExecutorJson(slot.candidate.evidence)
      || canonicalExecutorJson(admission.slot)
        !== canonicalExecutorJson(slot.candidate.selection.environment.find(item => item.index === slot.index))
      || canonicalExecutorJson({ ...selected, nonce: preparation.nonce,
        issuedAtMs: preparation.issuedAtMs, expiresAtMs: preparation.expiresAtMs })
          !== canonicalExecutorJson(preparation)
      || admission.issuedAtMs < preparation.issuedAtMs || admission.expiresAtMs > preparation.expiresAtMs
      || admission.issuedAtMs > Date.now() || admission.expiresAtMs <= Date.now()) {
      throw new SessionSecretPlanRefused()
    }
    return { slot, record, signed, admission }
  }, catch: () => new SessionSecretPlanRefused() })
  const context = yield* Effect.context<EffectServices<SessionExecutionResourcesEffect>>()
  yield* joinedNativeEffect(async signal => {
    const { slot, record, signed, admission } = captured
    let resolveDrained!: () => void
    const drained = new Promise<void>(resolve => { resolveDrained = resolve })
    const deadline = AbortSignal.timeout(Math.max(0, admission.expiresAtMs - Date.now()))
    const active = AbortSignal.any([parent, signal, record.stop.signal, record.source.signal, deadline])
    const check = () => {
      if (active.aborted || records.get(slot.plan) !== record || slot.state !== 'receiving'
        || Date.now() < admission.issuedAtMs || Date.now() >= admission.expiresAtMs) {
        throw new SessionSecretPlanRefused()
      }
    }
    const storage = Buffer.alloc(4 + 4096 + 4 + 65536 + 32)
    let ack: Buffer | undefined
    const stop = () => { valueInput.destroy(); ackOutput.destroy() }
    active.addEventListener('abort', stop, { once: true })
    const ignoreError = () => undefined
    valueInput.on('error', ignoreError); ackOutput.on('error', ignoreError)
    record.pending.add(drained)
    try {
      check()
      await Effect.runPromise(recheckSessionProviderSecretPlan(slot.plan).pipe(Effect.provide(context)),
        { signal: active })
      let used = 0, headerLength = 0, valueLength = -1, total = 0
      // Service closes its sole value writer before awaiting ACK on a separate
      // one-way channel. This EOF is framing completion, never process proof.
      for await (const chunk of valueInput) {
        if (!Buffer.isBuffer(chunk)) throw new SessionSecretPlanRefused()
        try {
          check()
          if (used + chunk.length > storage.length) throw new SessionSecretPlanRefused()
          chunk.copy(storage, used); used += chunk.length
          if (used >= 4 && headerLength === 0) {
            headerLength = storage.readUInt32LE(0)
            if (headerLength < 1 || headerLength > 4096) throw new SessionSecretPlanRefused()
          }
          if (headerLength && used >= 8 + headerLength && valueLength < 0) {
            valueLength = storage.readUInt32LE(4 + headerLength)
            if (valueLength > 65536) throw new SessionSecretPlanRefused()
            total = 8 + headerLength + valueLength + 32
          }
          if (total && used > total) throw new SessionSecretPlanRefused()
        } finally { chunk.fill(0) }
      }
      check()
      if (!total || used !== total) throw new SessionSecretPlanRefused()
      await Effect.runPromise(recheckSessionProviderSecretPlan(slot.plan).pipe(Effect.provide(context)),
        { signal: active })
      check()
      const value = storage.subarray(8 + headerLength, total - 32)
      const token = verifyProtectedT3SecretDelivery(storage.subarray(4, 4 + headerLength), value,
        storage.subarray(total - 32, total), signed)
      const variable = record.entry.environment?.[slot.index]
      if (!variable || typeof variable.value === 'string' || record.environment[slot.index] !== undefined) {
        throw new SessionSecretPlanRefused()
      }
      // Authentication, original conversion and exact-slot installation have no
      // intervening await. Values never enter the daemon, metadata or a getter.
      const installed = ProviderSecretPlan.resolveProviderEnvironmentVariable(variable,
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value))
      if (!installed) throw new SessionSecretPlanRefused()
      check()
      record.environment[slot.index] = installed
      storage.fill(0)
      ack = protectedT3SecretInstalledFrame(token)
      check()
      await new Promise<void>((resolve, reject) => {
        const fail = () => finish(false)
        const finish = (ok: boolean) => {
          active.removeEventListener('abort', fail)
          ackOutput.off('error', fail); ackOutput.off('close', fail)
          if (ok) resolve(); else reject(new SessionSecretPlanRefused())
        }
        active.addEventListener('abort', fail, { once: true })
        ackOutput.once('error', fail).once('close', fail)
        if (active.aborted || ackOutput.destroyed) { fail(); return }
        ackOutput.write(ack!, error => finish(!error))
      })
      check()
      slot.state = 'installed'
    } catch {
      slot.state = 'failed'
      record.environment.fill(undefined)
      record.stop.abort()
      throw new SessionSecretPlanRefused()
    } finally {
      storage.fill(0); ack?.fill(0)
      active.removeEventListener('abort', stop)
      stop()
      // Streams have fixed, nonsecret errors; retain error listeners through destroy.
      record.pending.delete(drained); resolveDrained()
    }
  }, () => new SessionSecretPlanRefused())
}).pipe(Effect.ensuring(Effect.sync(() => {
  const slot = reads.get(read), record = slot && records.get(slot.plan)
  if (slot && slot.state !== 'installed') {
    slot.state = 'failed'
    record?.environment.fill(undefined)
    record?.stop.abort()
  }
  // Drain and erase bytes already queued even when validation rejected before
  // the async receiver began. No incoming buffer is retained for a retry.
  try {
    let queued: unknown
    while ((queued = valueInput.read()) !== null) if (Buffer.isBuffer(queued)) queued.fill(0)
  } catch { throw new SessionSecretPlanRefused() }
  finally { valueInput.destroy(); ackOutput.destroy() }
})))
