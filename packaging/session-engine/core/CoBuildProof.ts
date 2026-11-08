import assert from 'node:assert/strict'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
// The exact T01 T3_CONTRACTS_SOURCE_ENTRY and published alias, in this one resolver namespace/root.
import * as ByEntry from 't3-source:packages/contracts/src/index.ts'
import * as ByAlias from '@nessie/t3-session-source/contracts'
import { createRequestPrivacyProjector }
  from 't3-source:packages/shared/src/t3McpToolPresentation.ts'
export * from './Engine.ts'
export { runSessionHistoryProof } from './HistoryProof.ts'
export { ByEntry as SourceContracts }

/** Synthetic codec/privacy qualification only; supplies no secret storage/delivery implementation. */
export const qualifySessionCoBuild = () => Effect.runPromise(Effect.gen(function* () {
  assert.equal(ByEntry.OrchestrationV2Command, ByAlias.OrchestrationV2Command)
  assert.equal(ByEntry.SecretRequestAnswerInput, ByAlias.SecretRequestAnswerInput)
  const secret = ' \r\n synthetic\u0000value\t 雪🔐 \r\n '
  const answer = yield* Schema.decodeUnknownEffect(ByAlias.SecretRequestAnswerInput)({
    threadId: 'synthetic:co-build', turnItemId: 'synthetic:request', answer: { type: 'save', secret },
  })
  assert.ok(answer.answer.type === 'save')
  assert.equal(answer.answer.secret, secret)
  const encoded = Schema.encodeSync(ByAlias.SecretRequestAnswerInput)(answer)
  assert.ok(encoded.answer.type === 'save')
  assert.equal(encoded.answer.secret, secret)
  const project = createRequestPrivacyProjector()
  const frames = [
    { id: 63, method: 'item/tool/call', params: { namespace: 't3-code', tool: 'request_secret',
      callId: 'native:co-build', arguments: { value: secret }, status: { result: { value: secret } } } },
    { id: 63, result: { contentItems: [{ type: 'inputText', text: secret }] } },
    { id: 63, error: { message: secret } },
    { params: { callId: 'native:co-build', result: { value: secret } } },
  ]
  for (const frame of [...frames, ...frames]) {
    assert.equal(JSON.stringify(project(frame)).includes(JSON.stringify(secret).slice(1, -1)), false)
  }
  let getters = 0
  const inaccessible = Object.defineProperty({}, 'value', { enumerable: true, get() { getters++; return secret } })
  assert.deepEqual(project(inaccessible), { privacy: 'request_projection_unavailable' })
  assert.equal(getters, 0)
  return { sourceAliasesShareSchemaObjects: true, canonicalSourceEntry: 'packages/contracts/src/index.ts',
    effect: '4.1.2', requestPrivacyPreservesValueBytes: true, artifactPrivacyCorrelationAndReplay: true,
    artifactPrivacyRejectsGetters: true, secretVaultOrDeliveryClaimed: false }
}))
