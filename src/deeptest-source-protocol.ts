export const DEEPTEST_SOURCE_PROTOCOL_VERSION = 1 as const

export const DEEPTEST_SOURCE_CAPABILITIES = [
  'source.snapshot',
  'source.inventory',
  'source.read',
  'source.release',
] as const

export type DeepTestSourceBinding = {
  account_id: string
  project_id: string
  review_id: string
  session_id: string
}

export type DeepTestSourceRequest = DeepTestSourceBinding & {
  operation: 'hello'
  protocol_version: 1
  request_id: string
} | DeepTestSourceBinding & {
  expected_commit: string
  expected_source_root: string
  operation: 'source.snapshot'
  protocol_version: 1
  request_id: string
} | DeepTestSourceBinding & {
  cursor?: string
  max_entries?: number
  operation: 'source.inventory'
  protocol_version: 1
  request_id: string
  snapshot_id: string
} | DeepTestSourceBinding & {
  operation: 'source.read'
  paths: string[]
  protocol_version: 1
  request_id: string
  snapshot_id: string
} | DeepTestSourceBinding & {
  operation: 'source.release'
  protocol_version: 1
  request_id: string
  snapshot_id: string
}

export type DeepTestSourceErrorCode =
  | 'BINDING_MISMATCH'
  | 'CAPABILITY_UNAVAILABLE'
  | 'COMMIT_MISMATCH'
  | 'FRAME_TOO_LARGE'
  | 'GIT_UNAVAILABLE'
  | 'GIT_LAYOUT_UNSUPPORTED'
  | 'OBJECT_FORMAT_UNSUPPORTED'
  | 'REQUEST_INVALID'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_LIMIT'
  | 'SOURCE_CHANGED'
  | 'SOURCE_INVENTORY_LIMIT'
  | 'SOURCE_UNAVAILABLE'

export type DeepTestSourceResponse = {
  protocol_version: 1
  request_id: string
  status: 'ok' | 'incomplete'
  result: Record<string, unknown>
} | {
  error: {
    code: DeepTestSourceErrorCode
    message: string
    retryable: boolean
  }
  protocol_version: 1
  request_id: string
  status: 'error'
}

const identifierPattern = /^[A-Za-z0-9:._-]{1,256}$/u
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/u
const snapshotIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const commitPattern = /^[0-9a-f]{40}$/u
const cursorPattern = /^(0|[1-9][0-9]{0,7})$/u

const isAbsoluteSourceRoot = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 8_192
  && !value.includes('\0') && path.isAbsolute(value)

const isSafeSourcePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024) return false
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const validBase = (value: Record<string, unknown>): boolean => (
  value.protocol_version === DEEPTEST_SOURCE_PROTOCOL_VERSION
  && typeof value.request_id === 'string'
  && requestIdPattern.test(value.request_id)
  && typeof value.account_id === 'string'
  && identifierPattern.test(value.account_id)
  && typeof value.project_id === 'string'
  && identifierPattern.test(value.project_id)
  && typeof value.review_id === 'string'
  && identifierPattern.test(value.review_id)
  && typeof value.session_id === 'string'
  && identifierPattern.test(value.session_id)
)

const baseKeys = [
  'account_id', 'operation', 'project_id', 'protocol_version', 'request_id', 'review_id', 'session_id',
] as const

export const parseDeepTestSourceRequest = (value: unknown): DeepTestSourceRequest => {
  if (!isRecord(value) || !validBase(value) || typeof value.operation !== 'string') {
    throw new Error('REQUEST_INVALID')
  }
  if (value.operation === 'hello' && exactKeys(value, baseKeys)) {
    return value as DeepTestSourceRequest
  }
  if (
    value.operation === 'source.snapshot'
    && exactKeys(value, [...baseKeys, 'expected_commit', 'expected_source_root'])
    && typeof value.expected_commit === 'string'
    && commitPattern.test(value.expected_commit)
    && isAbsoluteSourceRoot(value.expected_source_root)
  ) return value as DeepTestSourceRequest
  if (
    value.operation === 'source.inventory'
    && exactKeys(value, [...baseKeys, 'snapshot_id'], ['cursor', 'max_entries'])
    && typeof value.snapshot_id === 'string'
    && snapshotIdPattern.test(value.snapshot_id)
    && (value.cursor === undefined
      || (typeof value.cursor === 'string' && cursorPattern.test(value.cursor)))
    && (value.max_entries === undefined
      || (Number.isSafeInteger(value.max_entries) && Number(value.max_entries) >= 1
        && Number(value.max_entries) <= 500))
  ) return value as DeepTestSourceRequest
  if (
    value.operation === 'source.read'
    && exactKeys(value, [...baseKeys, 'paths', 'snapshot_id'])
    && typeof value.snapshot_id === 'string'
    && snapshotIdPattern.test(value.snapshot_id)
    && Array.isArray(value.paths)
    && value.paths.length <= 256
    && value.paths.every(isSafeSourcePath)
  ) return value as DeepTestSourceRequest
  if (
    value.operation === 'source.release'
    && exactKeys(value, [...baseKeys, 'snapshot_id'])
    && typeof value.snapshot_id === 'string'
    && snapshotIdPattern.test(value.snapshot_id)
  ) return value as DeepTestSourceRequest
  throw new Error('REQUEST_INVALID')
}

export const bindingFromRequest = (request: DeepTestSourceRequest): DeepTestSourceBinding => ({
  account_id: request.account_id,
  project_id: request.project_id,
  review_id: request.review_id,
  session_id: request.session_id,
})

export const sameDeepTestSourceBinding = (
  left: DeepTestSourceBinding,
  right: DeepTestSourceBinding,
): boolean => (
  left.account_id === right.account_id
  && left.project_id === right.project_id
  && left.review_id === right.review_id
  && left.session_id === right.session_id
)
import path from 'node:path'
