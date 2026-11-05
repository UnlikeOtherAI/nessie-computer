import { z } from 'zod'

import { NonEmptyStringSchema } from './schema-primitives.js'

export type ApiResponse<T> = {
  data: T
  meta?: PaginationMeta
}

export type ApiError = {
  error: {
    code: string
    message: string
    field?: string
    details?: unknown
  }
}

export const ApiErrorSchema = z.object({
  error: z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    field: NonEmptyStringSchema.optional(),
    details: z.unknown().optional(),
  }),
})

export const PaginationDirectionSchema = z.enum(['forward', 'backward'])
export type PaginationDirection = z.infer<typeof PaginationDirectionSchema>

/**
 * How every list endpoint is asked for a page.
 *
 * Five services had each written the same keyset paging by hand, two more used
 * offset, and about ten list endpoints took a bare `limit` with no way to
 * reach the rest of the rows at all. These schemas existed the whole time and
 * nothing imported them; that is the drift the content system closes.
 *
 * The default page is 25 and the ceiling is 100. Admin lists offer the same
 * small set of page sizes; the selected size belongs in the URL with the
 * cursor, so a reload, share, or Back navigation preserves the view exactly.
 */
export const DEFAULT_PAGE_LIMIT = 25
export const MAX_PAGE_LIMIT = 100
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const

export const PaginationParamsSchema = z.object({
  cursor: z.string().optional(),
  // Query-string values arrive as strings; route contracts compose this
  // schema directly, so coerce at the shared wire boundary.
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  direction: PaginationDirectionSchema.optional(),
})
export type PaginationParams = z.infer<typeof PaginationParamsSchema>

export const SortOrderSchema = z.enum(['asc', 'desc'])
export type SortOrder = z.infer<typeof SortOrderSchema>

/**
 * The query a paged list route accepts, as it arrives on the wire — every
 * value is a string, so `limit` is coerced here rather than at each call site.
 * A route composes this with its own `sort` whitelist and its own named
 * filters; `q` is free-text search, and the server is what filters and ranks.
 */
export const ListQuerySchema = z.object({
  cursor: z.string().optional(),
  direction: PaginationDirectionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  order: SortOrderSchema.optional(),
  q: z.string().max(200).optional(),
  sort: z.string().max(64).optional(),
})
export type ListQuery = z.infer<typeof ListQuerySchema>

/**
 * What a list endpoint reports about the page it just returned.
 *
 * `nextCursor` and `prevCursor` are both here because Previous and Next are
 * both real controls; the single `cursor` this replaced could only move
 * forward, which is why every list that had one still rendered no pagination.
 * Both are opaque: the server encodes its own sort key into them, and no
 * client may parse or construct one.
 *
 * `total` is optional in the type and **required in practice for admin
 * lists** — it is what turns "Page 2" into "26–50 of 134". It is omitted only
 * where counting is not meaningful, as in ranked search results.
 */
export const PaginationMetaSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
})
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>

export const createApiResponseSchema = <TSchema extends z.ZodTypeAny>(
  dataSchema: TSchema,
) =>
  z.object({
    data: dataSchema,
    meta: PaginationMetaSchema.optional(),
  }).superRefine((response, context) => {
    // `z.unknown()` accepts `undefined`, which makes a required object key
    // appear optional. Every successful JSON response owns `data`; `null` is
    // still a deliberate payload and remains valid when the domain permits it.
    if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Response data is required.' })
    }
  })
