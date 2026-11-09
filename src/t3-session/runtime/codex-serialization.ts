import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { CodexErrors, EffectCommand, type CodexSerializedOutput } from '@nessie/t3-session-source/engine'
import type { T3ExecutionPreparation, T3ExecutionIssuerDescriptor, T3ExecutionReceipt }
  from '@nessie/executor-protocol/t3-session'
import type { ProtectedT3Provider } from '../../t3-protected-provider.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { createProtectedProviderSerialization, type CapturedProviderFrame } from './provider-serialization.js'
import { joinedNativeEffect } from './native-effect.js'
import type { SessionLaunchCommandLineage } from './command-lineage.js'

const refused = () => new CodexErrors.CodexAppServerTransportError({
  operation: 'write-output-stream', cause: new Error('T3_ORIGINAL_SERIALIZATION_REFUSED'),
})
export interface ProtectedCodexSerialization {
  readonly output: CodexSerializedOutput
  finishBootstrap(): Promise<void>
  acceptAssociation(receipt: T3ExecutionReceipt): void
  close(): Promise<void>
}

/** Original Codex Effect port over the shared exact-byte native writer. */
export function createProtectedCodexSerialization(provider: ProtectedT3Provider,
  transport: T3NativeExecutionTransport, issuer: T3ExecutionIssuerDescriptor,
  preparation: T3ExecutionPreparation, parent: AbortSignal,
  lineage: SessionLaunchCommandLineage): ProtectedCodexSerialization {
  if (preparation.binding.driver !== 'codex') throw refused()
  const held = createProtectedProviderSerialization(provider, transport, issuer, preparation, parent)
  let associated = false
  const expose = (captured: CapturedProviderFrame,
    check: Effect.Effect<void, CodexErrors.CodexAppServerTransportError> = Effect.void) => Object.freeze({
    write: check.pipe(Effect.andThen(joinedNativeEffect(signal => captured.write(signal), refused))),
    discard: Effect.promise(captured.discard),
  })
  return Object.freeze<ProtectedCodexSerialization>({
    output: Object.freeze<CodexSerializedOutput>({
      capture: encoded => Effect.gen(function* () {
        if (!associated) return yield* Effect.try({ try: () => expose(held.capture(encoded)), catch: refused })
        const actual = yield* EffectCommand.OriginalEffectCommandContext
        if (!actual || actual.effectType !== 'provider-turn.start' || !actual.runId) {
          return yield* Effect.fail(refused())
        }
        // This is the original executor's persisted command and run, captured
        // before Queue.offer. Queue drain cannot substitute a later command.
        const effect = Object.freeze({ commandId: actual.commandId, threadId: actual.threadId,
          request: Object.freeze({ type: 'provider-turn.start' as const, runId: actual.runId }) })
        const check = lineage.assertProviderTurnStart(effect).pipe(Effect.mapError(refused))
        return yield* Effect.acquireUseRelease(
          Effect.try({ try: () => held.captureEffect(encoded), catch: refused }),
          captured => check.pipe(Effect.map(() => expose(captured, check))),
          (captured, exit) => Exit.isFailure(exit) ? Effect.promise(captured.discard) : Effect.void,
        )
      }),
      refuse: protocolId => joinedNativeEffect(() => held.refuse(protocolId), refused),
    }),
    finishBootstrap: held.finishBootstrap,
    acceptAssociation: receipt => { held.acceptAssociation(receipt); associated = true },
    close: held.close,
  })
}
