import { z } from 'zod'

/** Transport limits, not original result pagination or a stream capability. */
export const T3_FINITE_FRAGMENT_LIMITS = Object.freeze({
  bytes: 1024 * 1024, totalBytes: 128 * 1024 * 1024, bufferedBytes: 128 * 1024 * 1024,
})
const base64Bytes = 4 * Math.ceil(T3_FINITE_FRAGMENT_LIMITS.bytes / 3)
export const T3FiniteFragmentSchema = z.object({
  version: z.literal(1), encoding: z.literal('base64'),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  totalBytes: z.number().int().positive().max(T3_FINITE_FRAGMENT_LIMITS.totalBytes),
  count: z.number().int().min(2).max(Math.ceil(T3_FINITE_FRAGMENT_LIMITS.totalBytes / T3_FINITE_FRAGMENT_LIMITS.bytes)),
  index: z.number().int().nonnegative(),
  data: z.string().min(4).max(base64Bytes).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
}).strict().superRefine((value, context) => {
  if (value.index >= value.count || value.data.length % 4 !== 0
    || value.count !== Math.ceil(value.totalBytes / T3_FINITE_FRAGMENT_LIMITS.bytes)) {
    context.addIssue({ code: 'custom', message: 'Invalid finite fragment geometry' })
  }
})
export type T3FiniteFragment = z.infer<typeof T3FiniteFragmentSchema>

/** Byte length is structural even when a UTF-8 code point crosses fragments. */
export const t3FiniteFragmentBytes = (fragment: Pick<T3FiniteFragment, 'index' | 'count' | 'totalBytes'>): number =>
  fragment.index === fragment.count - 1
    ? fragment.totalBytes - fragment.index * T3_FINITE_FRAGMENT_LIMITS.bytes : T3_FINITE_FRAGMENT_LIMITS.bytes
