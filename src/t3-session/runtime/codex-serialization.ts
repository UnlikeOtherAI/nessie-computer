import * as Effect from 'effect/Effect'
import { CodexErrors, type CodexSerializedOutput } from '@nessie/t3-session-source/engine'
import type { T3ExecutionPreparation, T3ExecutionIssuerDescriptor } from '@nessie/executor-protocol/t3-session'
import type { ProtectedT3Provider } from '../../t3-protected-provider.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { createProtectedProviderSerialization } from './provider-serialization.js'
import { joinedNativeEffect } from './native-effect.js'

const refused = () => new CodexErrors.CodexAppServerTransportError({
  operation: 'write-output-stream', cause: new Error('T3_ORIGINAL_SERIALIZATION_REFUSED'),
})
export interface ProtectedCodexSerialization {
  readonly output: CodexSerializedOutput
  finishBootstrap(): Promise<void>
  close(): Promise<void>
}

/** Original Codex Effect port over the shared exact-byte native writer. */
export function createProtectedCodexSerialization(provider: ProtectedT3Provider,
  transport: T3NativeExecutionTransport, issuer: T3ExecutionIssuerDescriptor,
  preparation: T3ExecutionPreparation, parent: AbortSignal): ProtectedCodexSerialization {
  if (preparation.binding.driver !== 'codex') throw refused()
  const held = createProtectedProviderSerialization(provider, transport, issuer, preparation, parent)
  return Object.freeze({
    output: Object.freeze<CodexSerializedOutput>({
      capture: encoded => Effect.try({ try: () => {
        const captured = held.capture(encoded)
        return Object.freeze({ write: joinedNativeEffect(signal => captured.write(signal), refused),
          discard: Effect.promise(captured.discard) })
      }, catch: refused }),
      refuse: protocolId => joinedNativeEffect(() => held.refuse(protocolId), refused),
    }),
    finishBootstrap: held.finishBootstrap,
    close: held.close,
  })
}
