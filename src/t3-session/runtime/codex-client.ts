import * as Effect from 'effect/Effect'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as Scope from 'effect/Scope'
import type { Readable } from 'node:stream'
import { CodexClient, CodexStdio, CodexErrors, type CodexSerializedOutput } from '@nessie/t3-session-source/engine'
import type { HeldNativeSessionProvider } from './native-launch.js'
import type { EffectValue } from './effect-types.js'
import { isSessionScopeOpen } from './native-effect.js'

type Termination = Parameters<typeof CodexStdio.makeTerminationError>[0]
type ExitCode = EffectValue<Termination['exitCode']>

/** Original Codex codecs, request-ID allocator, routing and protocol lifetime
 * over the service-held provider. The only output is the immutable encoder hook;
 * an accidental generic Stdio write defects before touching native stdin.
 * Build inside the original adapter's scope and join it before provider close. */
export const makeProtectedOriginalCodexClient = (provider: HeldNativeSessionProvider):
  Effect.Effect<CodexClient.CodexAppServerClient['Service'], never, Scope.Scope> => Effect.gen(function* () {
  if (provider.driver !== 'codex') return yield* Effect.die(new Error('T3_CODEX_PROVIDER_MISMATCH'))
  const scope = yield* Scope.Scope
  const current = Effect.suspend(() => isSessionScopeOpen(scope) ? Effect.void : Effect.fail(
    new CodexErrors.CodexAppServerTransportError({ operation: 'write-output-stream',
      cause: new Error('T3_CODEX_ORIGINAL_HOST_REFUSED') })))
  const serializedOutput: CodexSerializedOutput = {
    capture: encoded => current.pipe(Effect.andThen(provider.serialization.output.capture(encoded)),
      Effect.map(captured => Object.freeze({
        write: current.pipe(Effect.andThen(captured.write), Effect.andThen(current)), discard: captured.discard,
      }))),
    refuse: protocolId => current.pipe(Effect.andThen(provider.serialization.output.refuse(protocolId)),
      Effect.andThen(current)),
  }
  const incoming = async function* (input: Readable): AsyncIterable<Uint8Array> {
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array)) throw new Error('T3_PROVIDER_OUTPUT_INVALID')
      yield chunk
    }
  }
  const output = (input: Readable) => Stream.fromAsyncIterable(incoming(input),
    () => new Error('T3_PROVIDER_OUTPUT_FAILED')).pipe(Stream.orDie)
  // Preserve the original bounded stderr tail, EOF ordering and exit errors.
  const stderr = yield* CodexStdio.makeStderrTail(output(provider.process.stderr))
  const stdio = CodexStdio.makeChildStdio({ stdout: output(provider.process.stdout),
    stdin: Sink.die(new Error('T3_GENERIC_PROVIDER_INPUT_REFUSED')) }, stderr.awaitDrained)
  const exitCode = Effect.callback<ExitCode>(resume => {
    const ended = (code: number | null) => resume(code === null
      ? Effect.die(new Error('T3_PROVIDER_EXIT_UNKNOWN')) : Effect.succeed(code as ExitCode))
    if (provider.process.exitCode !== null) { ended(provider.process.exitCode); return }
    provider.process.once('exit', ended)
    return Effect.sync(() => { provider.process.off('exit', ended) })
  })
  const termination = CodexStdio.makeTerminationError({ exitCode,
    pid: provider.process.pid as Termination['pid'] }, stderr.read)
  return yield* CodexClient.make(stdio, { serializedOutput }, termination)
})
