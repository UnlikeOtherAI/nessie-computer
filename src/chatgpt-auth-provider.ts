import type { ExecutorInferenceSource, LocalInferenceAttemptRequest } from '@nessie/executor-protocol'

export type ChatgptInferenceSource = Extract<ExecutorInferenceSource, { kind: 'chatgpt' }>

/** A process-local credential lease. Never serialize it or pass it to the server. */
export type ChatgptAccessLease = {
  accessToken: string
  /** Includes caller cancellation and local disconnect/revocation fencing. */
  signal: AbortSignal
  /** Releases transport/lifecycle ownership only; never confirms provider usage. */
  release: () => Promise<void>
}

/**
 * Created for one exact paired executor connection. The auth implementation
 * independently verifies activation, owner/team, generation and consent.
 * Identity-only, inactive or unverified profiles never appear in this list.
 */
export type ChatgptAuthProvider = {
  listReadyProfiles: () => Promise<ChatgptInferenceSource[]>
  /** Public native permission metadata; absence means background is denied. */
  backgroundConsentRevision?: (source: ChatgptInferenceSource) => Promise<number | null>
  acquireAccess: (input: ({
    purpose: 'discovery'
  } | {
    purpose: 'inference'
    /** Mandatory inference context; missing fresh signed private authority
     * must be refused by the auth consumer before releasing a credential. */
    attempt: LocalInferenceAttemptRequest
  }) & {
    source: ChatgptInferenceSource
    signal: AbortSignal
  }) => Promise<ChatgptAccessLease>
}

export const sameChatgptSource = (left: ChatgptInferenceSource, right: ChatgptInferenceSource): boolean =>
  left.profileId === right.profileId && left.accountGeneration === right.accountGeneration
  && left.consentRevision === right.consentRevision
