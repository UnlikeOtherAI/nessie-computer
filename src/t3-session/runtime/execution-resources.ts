import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import type { T3ExecutionResourceReceipt } from '@nessie/executor-protocol'
import { ServerSettings } from '@nessie/t3-session-source/contracts'
import { Settings } from '@nessie/t3-session-source/engine'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../source/execution.js'
import { recheckSessionLaunchTarget, type PreparedSessionLaunchTarget, type SessionLaunchTargetCheck }
  from './launch-target.js'
import type { EffectFailure, EffectServices } from './effect-types.js'

export class SessionExecutionResourceRefused extends Error {
  constructor() { super('T3_SESSION_EXECUTION_RESOURCE_REFUSED'); this.name = 'SessionExecutionResourceRefused' }
}
export interface BoundSessionExecutionResources {
  readonly receipt: T3ExecutionResourceReceipt
  readonly continuationHomeKey: string
  readonly historyHomeKey: string
  readonly credentialBindingId: string
}
export type SessionExecutionResourcesEffect = Effect.Effect<BoundSessionExecutionResources,
  SessionExecutionResourceRefused | EffectFailure<SessionLaunchTargetCheck>, EffectServices<SessionLaunchTargetCheck>>

/** Bind original decoded configuration to real service-held HOME resources.
 * References prove directory identity only; this never opens credential files,
 * resolves a secret or derives a home from continuation/native identifiers.
 */
export const readSessionExecutionResources = (source: T3ExecutionResourceScope,
  selection: PreparedSessionLaunchTarget): SessionExecutionResourcesEffect => Effect.gen(function* () {
  const recognized = Effect.tryPromise({ try: () => recognizeT3ExecutionResource(source),
    catch: () => new SessionExecutionResourceRefused() })
  const receipt = yield* recognized
  yield* recheckSessionLaunchTarget(selection, selection.request)
  const raw = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.settingsBytes)) as unknown,
    catch: () => new SessionExecutionResourceRefused(),
  })
  // Original decoder diagnostics can contain the rejected configuration value.
  // Keep them inside this protected resource callback; settings may hold secrets.
  const held = yield* Schema.decodeUnknownEffect(ServerSettings)(raw).pipe(
    Effect.mapError(() => new SessionExecutionResourceRefused()))
  const current = yield* (yield* Settings.ServerSettingsReadService).getSettings
  if (canonicalExecutorJson(Schema.encodeSync(ServerSettings)(held))
    !== canonicalExecutorJson(Schema.encodeSync(ServerSettings)(current))) {
    return yield* Effect.fail(new SessionExecutionResourceRefused())
  }
  const refs = receipt.evidence.providerReferences.filter(reference =>
    reference.instanceId === selection.providerInstanceId && reference.driver === selection.driver)
  const continuation = refs.find(reference => reference.role === 'continuation')
  const history = refs.find(reference => reference.role === 'history')
  const credential = refs.find(reference => reference.role === 'credential')
  if (refs.length !== 3 || !continuation || !history || !credential
    || receipt.evidence.source.executorId !== selection.request.executorId
    || receipt.evidence.source.environmentId !== selection.request.environmentId) {
    return yield* Effect.fail(new SessionExecutionResourceRefused())
  }
  // Recognition after decode and dependent awaits fences source/config changes.
  yield* recognized
  yield* recheckSessionLaunchTarget(selection, selection.request)
  return { receipt, continuationHomeKey: continuation.referenceId,
    historyHomeKey: history.referenceId, credentialBindingId: credential.referenceId }
})
