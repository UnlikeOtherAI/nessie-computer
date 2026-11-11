import type { PersonalChatgptProfileStatus } from '@nessie/executor-protocol'
import { ExecutorApiError } from './api-client.js'
import { ChatgptAuthError } from './chatgpt-oauth-provider.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

/** Only closed public reasons cross the local console bridge, never provider diagnostics or credentials. */
export const publicChatgptFailure = (error: unknown): NonNullable<PersonalChatgptProfileStatus['reason']> => {
  if (error instanceof ExecutorApiError) {
    if (error.code === 'CHATGPT_DEPLOYMENT_UNAVAILABLE') return 'deployment_ineligible'
    if (['CHATGPT_AUTHORITY_UNAVAILABLE', 'CHATGPT_OWNER_UNAVAILABLE', 'EXECUTOR_CONNECTION_FENCED']
      .includes(error.code ?? '')) return 'owner_authority_unavailable'
    return 'connection_unavailable'
  }
  if (error instanceof ChatgptAuthError) return 'registration_unavailable'
  if (!(error instanceof PersonalInferenceProtectionError)) return 'connection_unavailable'
  // Another version of Nessie Computer is still running; a plan signs in once it has gone.
  if (error.code === 'personal_inference_incompatible_sessions') return 'host_sessions_active'
  if (error.code === 'chatgpt_owner_authority_unavailable') return 'owner_authority_unavailable'
  if (error.code === 'chatgpt_registration_scope_ambiguous') return 'account_replacement_requires_consent'
  return 'runtime_inventory_unknown'
}
