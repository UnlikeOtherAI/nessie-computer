import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { ServerSettings, ServerSettingsError } from '@nessie/t3-session-source/contracts'
import { Settings } from '@nessie/t3-session-source/engine'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../source/execution.js'

const unavailable = () => new ServerSettingsError({ settingsPath: '<protected>', operation: 'read-file' })

/** The original codec reads only the recognized resource's held bytes. This
 * implements the original read projection, not fake settings lifecycle/mutators.
 * No driver, secret resolver, directory loader or provider probe is constructed.
 * Decoded configuration never leaves the protected original graph context. */
export const sessionExecutionSettingsLayer = (source: T3ExecutionResourceScope):
  Layer.Layer<Settings.ServerSettingsReadService, ServerSettingsError> => {
  const getSettings = Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => recognizeT3ExecutionResource(source), catch: unavailable })
    const raw = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.settingsBytes)) as unknown,
      catch: unavailable,
    })
    const decoded = yield* Schema.decodeUnknownEffect(ServerSettings)(raw).pipe(Effect.mapError(unavailable))
    yield* Effect.tryPromise({ try: () => recognizeT3ExecutionResource(source), catch: unavailable })
    return decoded
  })
  return Layer.effect(Settings.ServerSettingsReadService, Effect.gen(function* () {
    yield* getSettings
    return { getSettings }
  }))
}
