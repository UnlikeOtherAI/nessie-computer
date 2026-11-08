import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { CodexSettings, ClaudeSettings, ProviderInstanceConfig, ServerSettings }
  from '@nessie/t3-session-source/contracts'
import { ProviderSecretPlan, Settings } from '@nessie/t3-session-source/engine'
import type { T3ExecutionResourceScope } from '../source/execution.js'
import { readSessionExecutionResources, type SessionExecutionResourcesEffect } from './execution-resources.js'
import type { PreparedSessionLaunchTarget } from './launch-target.js'
import type { EffectFailure, EffectServices } from './effect-types.js'

const sha = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')
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
  evidence: SessionProviderSecretPlanEvidence; settings: string }
const records = new WeakMap<HeldSessionProviderSecretPlan, Record>()
const token = Object.freeze({})

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
        settings: canonicalExecutorJson(Schema.encodeSync(ServerSettings)(settings)) })
      yield* readSessionExecutionResources(source, target)
      yield* Effect.addFinalizer(() => Effect.sync(() => { records.delete(plan) }))
      return plan
    })
}

/** Escaped plans and any settings/source/recipient replacement fail closed. */
export const recheckSessionProviderSecretPlan = (plan: HeldSessionProviderSecretPlan): Effect.Effect<void,
  SessionSecretPlanRefused | EffectFailure<SessionExecutionResourcesEffect>,
  EffectServices<SessionExecutionResourcesEffect>> => Effect.gen(function* () {
  const record = records.get(plan)
  if (!record) return yield* Effect.fail(new SessionSecretPlanRefused())
  const bound = yield* readSessionExecutionResources(record.source, record.target)
  const settings = yield* (yield* Settings.ServerSettingsReadService).getSettings
  if (bound.receipt.resourceId !== record.evidence.resourceId
    || bound.receipt.resourceGeneration !== record.evidence.resourceGeneration
    || canonicalExecutorJson(bound.receipt.custody) !== canonicalExecutorJson(record.evidence.recipient)
    || canonicalExecutorJson(Schema.encodeSync(ServerSettings)(settings)) !== record.settings) {
    return yield* Effect.fail(new SessionSecretPlanRefused())
  }
})
