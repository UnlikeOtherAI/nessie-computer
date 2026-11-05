/* eslint-disable max-len -- exact wire shapes are clearer when kept together. */
import { isAbsolute } from 'node:path'

export const DEEPTEST_EXECUTION_PROTOCOL_VERSION = 1 as const
export const DEEPTEST_EXECUTION_CAPABILITIES = [
  'execution.command.run', 'execution.browser.open', 'execution.browser.observe',
  'execution.browser.act', 'execution.release',
] as const

export type DeepTestExecutionBinding = {
  account_id: string
  project_id: string
  review_id: string
  session_id: string
}

export type DeepTestExecutionRoe = {
  allowed_origins: string[]
  expires_at: string
  scope: string
  stop_id: string
}

export type DeepTestExecutionRequest = DeepTestExecutionBinding & {
  operation: 'hello'
  protocol_version: 1
  request_id: string
} | DeepTestExecutionBinding & {
  args: string[]
  cwd?: string
  expected_commit: string
  expected_manifest_digest: string
  operation: 'execution.command.run'
  program: string
  protocol_version: 1
  request_id: string
  roe: DeepTestExecutionRoe
  run_id: string
} | DeepTestExecutionBinding & {
  expected_commit: string
  expected_manifest_digest: string
  operation: 'execution.browser.open'
  protocol_version: 1
  request_id: string
  roe: DeepTestExecutionRoe
  run_id: string
  url: string
} | DeepTestExecutionBinding & {
  operation: 'execution.browser.observe'
  protocol_version: 1
  request_id: string
  run_id: string
  include_screenshot?: boolean
} | DeepTestExecutionBinding & {
  action: Record<string, unknown>
  operation: 'execution.browser.act'
  protocol_version: 1
  request_id: string
  run_id: string
} | DeepTestExecutionBinding & {
  operation: 'execution.release'
  protocol_version: 1
  request_id: string
  run_id: string
  stop_id: string
}

export type DeepTestExecutionErrorCode =
  | 'BINDING_MISMATCH' | 'CAPABILITY_UNAVAILABLE' | 'REQUEST_INVALID'
  | 'ROE_EXPIRED' | 'ROE_SCOPE_DENIED' | 'SOURCE_CHANGED' | 'RUN_NOT_FOUND'

export type DeepTestExecutionResponse = {
  protocol_version: 1; request_id: string; status: 'ok'; result: Record<string, unknown>
} | {
  protocol_version: 1; request_id: string; status: 'error'
  error: { code: DeepTestExecutionErrorCode; message: string; retryable: boolean }
}

const identifier = /^[A-Za-z0-9:._-]{1,256}$/u
const requestId = /^[A-Za-z0-9_-]{1,128}$/u
const commit = /^[0-9a-f]{40}$/u
// Source snapshots expose the canonical manifest digest as `sha256:<hex>`.
// Keep this grammar exact so a raw digest cannot be confused with a future
// algorithm or silently bypass snapshot pinning.
const digest = /^sha256:[0-9a-f]{64}$/u
const run = /^[A-Za-z0-9_-]{1,128}$/u
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => key in value)
const base = ['account_id', 'operation', 'project_id', 'protocol_version', 'request_id', 'review_id', 'session_id']
const validBase = (value: Record<string, unknown>): boolean => value.protocol_version === 1
  && ['account_id', 'project_id', 'review_id', 'session_id'].every((key) => typeof value[key] === 'string' && identifier.test(value[key] as string))
  && typeof value.request_id === 'string' && requestId.test(value.request_id)
const validRoe = (value: unknown): value is DeepTestExecutionRoe => record(value)
  && exact(value, ['allowed_origins', 'expires_at', 'scope', 'stop_id'])
  && Array.isArray(value.allowed_origins) && value.allowed_origins.every((origin) => typeof origin === 'string')
  && typeof value.expires_at === 'string' && !Number.isNaN(Date.parse(value.expires_at))
  && typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 1024
  && typeof value.stop_id === 'string' && identifier.test(value.stop_id)
const validRun = (value: Record<string, unknown>): boolean => typeof value.run_id === 'string' && run.test(value.run_id)
const validSnapshot = (value: Record<string, unknown>): boolean => typeof value.expected_commit === 'string'
  && commit.test(value.expected_commit) && typeof value.expected_manifest_digest === 'string' && digest.test(value.expected_manifest_digest)

export const parseDeepTestExecutionRequest = (value: unknown): DeepTestExecutionRequest => {
  if (!record(value) || !validBase(value) || typeof value.operation !== 'string') throw new Error('REQUEST_INVALID')
  if (value.operation === 'hello' && exact(value, base)) return value as DeepTestExecutionRequest
  if (value.operation === 'execution.command.run' && exact(value, [...base, 'args', 'cwd', 'expected_commit', 'expected_manifest_digest', 'program', 'roe', 'run_id'].filter((key) => key !== 'cwd' || value.cwd !== undefined))
    && validRun(value) && validSnapshot(value) && validRoe(value.roe) && typeof value.program === 'string' && value.program.length > 0
    && Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string')
    && (value.cwd === undefined || (typeof value.cwd === 'string' && !isAbsolute(value.cwd)))) return value as DeepTestExecutionRequest
  if (value.operation === 'execution.browser.open' && exact(value, [...base, 'expected_commit', 'expected_manifest_digest', 'roe', 'run_id', 'url'])
    && validRun(value) && validSnapshot(value) && validRoe(value.roe) && typeof value.url === 'string') return value as DeepTestExecutionRequest
  if (value.operation === 'execution.browser.observe' && exact(value, [...base, 'include_screenshot', 'run_id'].filter((key) => key !== 'include_screenshot' || value.include_screenshot !== undefined))
    && validRun(value) && (value.include_screenshot === undefined || typeof value.include_screenshot === 'boolean')) return value as DeepTestExecutionRequest
  if (value.operation === 'execution.browser.act' && exact(value, [...base, 'action', 'run_id']) && validRun(value) && record(value.action)) return value as DeepTestExecutionRequest
  if (value.operation === 'execution.release' && exact(value, [...base, 'run_id', 'stop_id']) && validRun(value) && typeof value.stop_id === 'string' && identifier.test(value.stop_id)) return value as DeepTestExecutionRequest
  throw new Error('REQUEST_INVALID')
}

export const bindingFromExecutionRequest = (request: DeepTestExecutionRequest): DeepTestExecutionBinding => ({ account_id: request.account_id, project_id: request.project_id, review_id: request.review_id, session_id: request.session_id })
export const sameDeepTestExecutionBinding = (left: DeepTestExecutionBinding, right: DeepTestExecutionBinding): boolean => Object.keys(left).every((key) => left[key as keyof DeepTestExecutionBinding] === right[key as keyof DeepTestExecutionBinding])
