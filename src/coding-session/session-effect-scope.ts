import { ExecutorCodingSessionAuthoritySchema, type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { T3EffectGrantReferenceSchema, type T3EffectGrantReference } from '@nessie/executor-protocol/t3-session'

/** A serialized selection is not a grant. The owning signed route must consume it. */
export type SessionEffectScope = ExecutorCodingSessionAuthority | T3EffectGrantReference
export const isT3EffectScope = (scope: SessionEffectScope): scope is T3EffectGrantReference =>
  'kind' in scope && scope.kind === 't3-effect'

export const exactHttpsOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value }
  catch { return false }
}

export const parseSessionEffectScope = (value: unknown): SessionEffectScope => {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 't3-effect') {
    return T3EffectGrantReferenceSchema.parse(value)
  }
  return ExecutorCodingSessionAuthoritySchema.parse(value)
}

/** App identities remain separate. Neither a native ID nor an environment alone selects a T3 thread. */
export const sameT3EffectTarget = (first: T3EffectGrantReference, next: T3EffectGrantReference): boolean => (
  first.executorId === next.executorId && first.environmentId === next.environmentId
  && first.threadId === next.threadId && first.providerSessionId === next.providerSessionId
  && first.connectionEpoch === next.connectionEpoch && first.runtimeGeneration === next.runtimeGeneration
  && first.nativeAssociation.driver === next.nativeAssociation.driver
  && first.nativeAssociation.nativeId === next.nativeAssociation.nativeId
  && first.nativeAssociation.continuationHomeKey === next.nativeAssociation.continuationHomeKey
  && first.nativeAssociation.historyHomeKey === next.nativeAssociation.historyHomeKey
)

export const sameT3EffectOperation = (first: T3EffectGrantReference, next: T3EffectGrantReference): boolean => (
  sameT3EffectTarget(first, next) && first.correlationId === next.correlationId
  && first.commandId === next.commandId && first.requestDigest === next.requestDigest
)

/** Managed launch can acquire its actual session evidence once; T3's exact target is fixed from admission. */
export const retainEffectSession = (
  first: SessionEffectScope | undefined, next: SessionEffectScope,
): SessionEffectScope => {
  if (!first) return next
  if (!isT3EffectScope(first) && !isT3EffectScope(next)
    && !first.admissions.length && next.admissions.length) return next
  return first
}
