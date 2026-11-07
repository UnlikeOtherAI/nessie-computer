import * as Schema from 'effect/Schema'
import { EnvironmentHttpApi, EnvironmentAuthenticatedAuth } from '@nessie/t3-session-source/contracts'
import type * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'

export const ExecutorT3HttpEndpoints: typeof EnvironmentHttpApi.groups.orchestration.endpoints =
  EnvironmentHttpApi.groups.orchestration.endpoints
export type ExecutorT3HttpEndpoint = keyof typeof ExecutorT3HttpEndpoints
type Endpoint<K extends ExecutorT3HttpEndpoint> = typeof ExecutorT3HttpEndpoints[K]
export type ExecutorT3HttpInput<K extends ExecutorT3HttpEndpoint> = {
  readonly params: Endpoint<K>['~Params']['Encoded']
  readonly query: Endpoint<K>['~Query']['Encoded']
  readonly headers: Endpoint<K>['~Headers']['Encoded']
}
export type ExecutorT3HttpSuccess<K extends ExecutorT3HttpEndpoint> = Endpoint<K>['~Success']['Encoded']
export type ExecutorT3HttpAuthErrorSchema = HttpApiMiddleware.ErrorSchema<EnvironmentAuthenticatedAuth>
export type ExecutorT3HttpError<K extends ExecutorT3HttpEndpoint> =
  Endpoint<K>['~Error']['Encoded'] | ExecutorT3HttpAuthErrorSchema['Encoded']

// HttpApi keeps exact schema types in phantom properties and widens runtime
// properties. Reconnect them by identity against the original descriptor.
export const httpParams = <S extends Schema.Top>(endpoint: {
  readonly '~Params': S; readonly params: Schema.Top | undefined
}): S => {
  const schema = endpoint.params
  const matches = (candidate: Schema.Top): candidate is S => candidate === endpoint.params
  if (!schema || !matches(schema)) throw new Error('T3_HTTP_PARAMS_ABSENT')
  return schema
}
export const httpQuery = <S extends Schema.Top>(endpoint: {
  readonly '~Query': S; readonly query: Schema.Top | undefined
}): S => {
  const schema = endpoint.query
  const matches = (candidate: Schema.Top): candidate is S => candidate === endpoint.query
  if (!schema || !matches(schema)) throw new Error('T3_HTTP_QUERY_ABSENT')
  return schema
}
export const httpHeaders = <S extends Schema.Top>(endpoint: {
  readonly '~Headers': S; readonly headers: Schema.Top | undefined
}): S => {
  const schema = endpoint.headers
  const matches = (candidate: Schema.Top): candidate is S => candidate === endpoint.headers
  if (!schema || !matches(schema)) throw new Error('T3_HTTP_HEADERS_ABSENT')
  return schema
}
export const httpSuccess = <S extends Schema.Top>(endpoint: {
  readonly '~Success': S; readonly success: ReadonlySet<Schema.Top>
}): Schema.Union<S[]> => Schema.Union([...endpoint.success].filter(
  (candidate): candidate is S => endpoint.success.has(candidate),
))
export const httpError = <S extends Schema.Top>(endpoint: {
  readonly '~Error': S; readonly '~Middleware': EnvironmentAuthenticatedAuth; readonly error: ReadonlySet<Schema.Top>
}): Schema.Union<(S | ExecutorT3HttpAuthErrorSchema)[]> => Schema.Union([
  ...[...endpoint.error].filter((candidate): candidate is S => endpoint.error.has(candidate)),
  ...[...EnvironmentAuthenticatedAuth.error].filter((candidate): candidate is ExecutorT3HttpAuthErrorSchema =>
    EnvironmentAuthenticatedAuth.error.has(candidate)),
])

/** Raw endpoint/status/error contracts, never Nessie's ordinary API wrapper. */
export const ExecutorT3HttpDescriptors: typeof EnvironmentHttpApi.groups = EnvironmentHttpApi.groups
