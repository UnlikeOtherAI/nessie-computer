export const LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY = '_malformedArguments'

/** One object-only decoder for provider calls and opaque history validation. */
export const decodeProviderToolArguments = (raw: string): Record<string, unknown> => {
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { parsed = undefined }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : { [LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY]: raw }
}
