import assert from 'node:assert/strict'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
// The exact T01 T3_CONTRACTS_SOURCE_ENTRY and published alias, in this one resolver namespace/root.
import * as ByEntry from 't3-source:packages/contracts/src/index.ts'
import * as ByAlias from '@nessie/t3-session-source/contracts'
export * from './Engine.ts'
export { runSessionHistoryProof } from './HistoryProof.ts'
export { ByEntry as SourceContracts }

/** Synthetic codec qualification only; never supplies a secret storage/delivery implementation. */
export const qualifySessionCoBuild = () => Effect.runPromise(Effect.gen(function* () {
  assert.equal(ByEntry.OrchestrationV2Command, ByAlias.OrchestrationV2Command)
  assert.equal(ByEntry.SecretRequestAnswerInput, ByAlias.SecretRequestAnswerInput)
  const secret = '\n synthetic value\t '
  const answer = yield* Schema.decodeUnknownEffect(ByAlias.SecretRequestAnswerInput)({
    threadId: 'synthetic:co-build', turnItemId: 'synthetic:request', answer: { type: 'save', secret },
  })
  assert.ok(answer.answer.type === 'save')
  assert.equal(answer.answer.secret, secret)
  return { sourceAliasesShareSchemaObjects: true, canonicalSourceEntry: 'packages/contracts/src/index.ts',
    effect: '4.1.2', requestPrivacyPreservesValueBytes: true, secretVaultOrDeliveryClaimed: false }
}))
