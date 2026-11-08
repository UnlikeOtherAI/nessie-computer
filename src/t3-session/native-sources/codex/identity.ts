/** Native identities are data. Only the canonical resource/owner producer admits them. */
export interface CodexHomeIdentity {
  readonly executorId: string
  readonly continuationHomeKey: string
  readonly historyHomeKey: string
}

export interface CodexNativeIdentity extends CodexHomeIdentity {
  readonly source: 'codex'
  readonly nativeId: string
}

export class CodexSourceFailure extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'CodexSourceFailure'; this.code = code }
}

export function requireCodex(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CodexSourceFailure(code)
}

export function codexIdentity(home: CodexHomeIdentity, nativeId: string): CodexNativeIdentity {
  for (const value of [home.executorId, home.continuationHomeKey, home.historyHomeKey, nativeId]) {
    requireCodex(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096,
      'codex_identity_invalid')
  }
  return Object.freeze({ source: 'codex', executorId: home.executorId,
    continuationHomeKey: home.continuationHomeKey, historyHomeKey: home.historyHomeKey, nativeId })
}

/** No path normalization, UUID conversion, title matching or provider-instance election. */
export const codexIdentityKey = (identity: CodexNativeIdentity): string => JSON.stringify([
  identity.source, identity.executorId, identity.continuationHomeKey, identity.historyHomeKey, identity.nativeId,
])

export interface CodexT3Association extends CodexHomeIdentity {
  readonly driver: string
  readonly nativeId: string
  readonly environmentId: string
  readonly threadId: string
  readonly providerThreadId: string
  readonly sourceState: 'unknown' | 'active' | 'archived' | 'deleted'
  readonly strength: 'strong' | 'weak' | 'none'
  readonly homeProofReference: string
}

/** Input comes from the admitted association index, not a client-provided alias assertion.
 * Tombstoned app owners remain candidates. Each target still requires its own read grant.
 */
export function codexAssociationCandidates(identity: CodexNativeIdentity, aliases: readonly CodexT3Association[]) {
  const candidates = aliases.filter(alias => alias.driver === 'codex' && alias.nativeId === identity.nativeId &&
    alias.executorId === identity.executorId && alias.continuationHomeKey === identity.continuationHomeKey &&
    alias.historyHomeKey === identity.historyHomeKey)
  const apps = new Set(candidates.map(alias => JSON.stringify([alias.environmentId, alias.threadId])))
  return { candidates, state: candidates.length === 0 ? 'missing' as const
    : candidates.some(alias => alias.strength !== 'strong' || !alias.homeProofReference) ? 'unproven' as const
      : apps.size > 1 ? 'ambiguous' as const : 'one-app-history' as const,
  control: 'unavailable' as const }
}
