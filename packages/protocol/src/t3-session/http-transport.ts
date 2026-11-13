import * as Schema from 'effect/Schema'
import { EnvironmentAuthenticatedAuth } from '@nessie/t3-session-source/contracts'
import { ExecutorT3Routing } from './routing.js'
import { ExecutorT3HttpEndpoints as E, httpParams, httpQuery, httpHeaders, httpSuccess, httpError,
  type ExecutorT3HttpEndpoint, type ExecutorT3HttpAuthErrorSchema } from './http.js'

const requestFields = { ...ExecutorT3Routing.fields, kind: Schema.Literal('http-request') }
const requests = Schema.Union([
  Schema.Struct({ ...requestFields, endpoint: Schema.Literal('shellSnapshot'),
    query: httpQuery(E.shellSnapshot), headers: httpHeaders(E.shellSnapshot) }),
  Schema.Struct({ ...requestFields, endpoint: Schema.Literal('threadSnapshot'),
    params: httpParams(E.threadSnapshot), headers: httpHeaders(E.threadSnapshot) }),
  Schema.Struct({ ...requestFields, endpoint: Schema.Literal('threadTranscript'),
    params: httpParams(E.threadTranscript), headers: httpHeaders(E.threadTranscript) }),
  Schema.Struct({ ...requestFields, endpoint: Schema.Literal('threadBoundedSnapshot'),
    params: httpParams(E.threadBoundedSnapshot), query: httpQuery(E.threadBoundedSnapshot),
    headers: httpHeaders(E.threadBoundedSnapshot) }),
  Schema.Struct({ ...requestFields, endpoint: Schema.Literal('threadHistoryPage'),
    params: httpParams(E.threadHistoryPage), query: httpQuery(E.threadHistoryPage),
    headers: httpHeaders(E.threadHistoryPage) }),
]).check(Schema.makeFilter(request => !request.headers.authorization && !request.headers.dpop
  && (!request.sourceThreadId || 'params' in request && request.params.threadId === request.sourceThreadId)))
export type ExecutorT3HttpRequest = typeof requests.Type
export const ExecutorT3HttpRequest: Schema.Codec<ExecutorT3HttpRequest, typeof requests.Encoded> = requests

type Endpoint<K extends ExecutorT3HttpEndpoint> = typeof E[K]
export type ExecutorT3HttpReply = { [K in ExecutorT3HttpEndpoint]: ExecutorT3Routing & {
  readonly kind: 'http-result'; readonly endpoint: K; readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Endpoint<K>['~Success']['Type']
} }[ExecutorT3HttpEndpoint]
export type ExecutorT3HttpReplyEncoded = { [K in ExecutorT3HttpEndpoint]: typeof ExecutorT3Routing.Encoded & {
  readonly kind: 'http-result'; readonly endpoint: K; readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Endpoint<K>['~Success']['Encoded']
} }[ExecutorT3HttpEndpoint]
export type ExecutorT3HttpFailure = { [K in ExecutorT3HttpEndpoint]: ExecutorT3Routing & {
  readonly kind: 'http-error'; readonly endpoint: K; readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Endpoint<K>['~Error']['Type'] | ExecutorT3HttpAuthErrorSchema['Type']
} }[ExecutorT3HttpEndpoint]
export type ExecutorT3HttpFailureEncoded = { [K in ExecutorT3HttpEndpoint]: typeof ExecutorT3Routing.Encoded & {
  readonly kind: 'http-error'; readonly endpoint: K; readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Endpoint<K>['~Error']['Encoded'] | ExecutorT3HttpAuthErrorSchema['Encoded']
} }[ExecutorT3HttpEndpoint]
const replyFields = { ...ExecutorT3Routing.fields, kind: Schema.Literal('http-result'),
  headers: Schema.Record(Schema.String, Schema.String),
  status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(200), Schema.isLessThanOrEqualTo(299)) }
const errorFields = { ...ExecutorT3Routing.fields, kind: Schema.Literal('http-error'),
  headers: Schema.Record(Schema.String, Schema.String),
  status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(400), Schema.isLessThanOrEqualTo(599)) }
export const ExecutorT3HttpReply: Schema.Codec<ExecutorT3HttpReply, ExecutorT3HttpReplyEncoded> = Schema.Union([
  Schema.Struct({ ...replyFields, endpoint: Schema.Literal('shellSnapshot'), body: httpSuccess(E.shellSnapshot) }),
  Schema.Struct({ ...replyFields, endpoint: Schema.Literal('threadSnapshot'), body: httpSuccess(E.threadSnapshot) }),
  Schema.Struct({ ...replyFields, endpoint: Schema.Literal('threadTranscript'), body: httpSuccess(E.threadTranscript) }),
  Schema.Struct({ ...replyFields, endpoint: Schema.Literal('threadBoundedSnapshot'), body: httpSuccess(E.threadBoundedSnapshot) }),
  Schema.Struct({ ...replyFields, endpoint: Schema.Literal('threadHistoryPage'), body: httpSuccess(E.threadHistoryPage) }),
])
export const ExecutorT3HttpFailure: Schema.Codec<ExecutorT3HttpFailure, ExecutorT3HttpFailureEncoded> = Schema.Union([
  Schema.Struct({ ...errorFields, endpoint: Schema.Literal('shellSnapshot'), body: httpError(E.shellSnapshot) }),
  Schema.Struct({ ...errorFields, endpoint: Schema.Literal('threadSnapshot'), body: httpError(E.threadSnapshot) }),
  Schema.Struct({ ...errorFields, endpoint: Schema.Literal('threadTranscript'), body: httpError(E.threadTranscript) }),
  Schema.Struct({ ...errorFields, endpoint: Schema.Literal('threadBoundedSnapshot'), body: httpError(E.threadBoundedSnapshot) }),
  Schema.Struct({ ...errorFields, endpoint: Schema.Literal('threadHistoryPage'), body: httpError(E.threadHistoryPage) }),
]).check(Schema.makeFilter(reply => [...E[reply.endpoint].error, ...EnvironmentAuthenticatedAuth.error].some(codec =>
  codec.ast.annotations?.httpApiStatus === reply.status && Schema.is(codec)(reply.body),
)))

export const requireExecutorT3HttpCorrelation = (
  request: ExecutorT3HttpRequest, reply: ExecutorT3HttpReply | ExecutorT3HttpFailure,
): void => {
  if (request.executorId !== reply.executorId || request.environmentId !== reply.environmentId
    || request.connectionEpoch !== reply.connectionEpoch || request.runtimeGeneration !== reply.runtimeGeneration
    || request.correlationId !== reply.correlationId || request.endpoint !== reply.endpoint) {
    throw new Error('T3_HTTP_REPLY_CORRELATION_MISMATCH')
  }
}
