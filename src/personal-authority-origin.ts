import { PersonalInferenceAuthoritySchema, type PersonalInferenceAuthority } from '@nessie/executor-protocol'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

/** Bind the signed projection to this locally paired endpoint, not an origin asserted by another pairing. */
export const pairedPersonalAuthority = (
  value: unknown, pairedApiUrl: string,
): PersonalInferenceAuthority | undefined => {
  if (value === undefined) return undefined
  const parsed = PersonalInferenceAuthoritySchema.safeParse(value)
  let origin: string
  try { origin = new URL(pairedApiUrl).origin }
  catch { throw new PersonalInferenceProtectionError('personal_inference_authority_origin_invalid') }
  if (!parsed.success || parsed.data.principal.serverOrigin !== origin) {
    throw new PersonalInferenceProtectionError('personal_inference_authority_origin_invalid')
  }
  return parsed.data
}
