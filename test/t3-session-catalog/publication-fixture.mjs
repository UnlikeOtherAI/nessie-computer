import { generateKeyPairSync, verify } from 'node:crypto'
import assert from 'node:assert/strict'
import { canonicalExecutorPayload, canonicalExecutorJson } from '@nessie/executor-protocol'
import { executorApi } from '../../dist/api-client.js'
import { captureRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { withHeldRetainedCatalogGraph } from '../../dist/t3-session/catalog/held-graph.js'
import { engineFixture } from '../t3-session-import/engine-fixture.mjs'

export const owner = { scope: 'environment-owner', basis: 'prospective-import-grant', revision: 'synthetic:publish:1' }
export async function publicationFixture(options) {
  const f = await engineFixture(options)
  const capture = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
  let selection = owner
  let revision = 1
  const authority = { withCatalogPublicationScope: async (request, use) => {
    assert.equal(request.purpose, 'retained-catalog-publish')
    const issued = revision
    const recheck = async () => { assert.equal(revision, issued, 'synthetic selection revoked') }
    const result = await use({ selection, publicationGrantId: 'b2cb87a3-b0de-4e06-bc05-f3fc0453db11',
      selectionKey: selection.revision, recheckSelection: recheck, recheckSource: recheck,
      recheckThread: async () => { throw new Error('publication must recheck the canonical selection, not HTTP per row') } })
    await recheck()
    return result
  } }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const state = { executorId: '3f949715-47eb-4c29-8618-00d6c02f9cdf', connectionEpoch: '1',
    apiBaseUrl: 'http://127.0.0.1:1', machinePrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    machinePublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
  const original = executorApi.publishT3Catalog
  const pages = new Map()
  const exchanges = []
  let completed = false
  let onExchange = async () => {}
  let onLocalRecheck = async () => {}
  executorApi.publishT3Catalog = async (_url, signed) => {
    const { signature, ...payload } = signed
    assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.t3_catalog.v1', payload)),
      publicKey, Buffer.from(signature, 'base64url')))
    exchanges.push(payload)
    const publication = payload.publication
    if (payload.operation === 't3.catalog.page') {
      const old = pages.get(payload.page.pageOrdinal)
      if (old) assert.equal(canonicalExecutorJson(old), canonicalExecutorJson(payload.page))
      else { assert.equal(payload.page.pageOrdinal, pages.size); pages.set(payload.page.pageOrdinal, payload.page) }
    } else completed = true
    const response = { publicationId: 'f4be9da5-2b86-410f-a6bb-b628aa11cc9f', state: completed ? 'complete' : 'staging',
      captureGeneration: publication.captureGeneration, selectionKey: publication.selectionKey,
      nextPage: pages.size, nextEntry: [...pages.values()].reduce((sum, page) => sum + page.entries.length, 0),
      totalPages: publication.totalPages, totalEntries: publication.totalEntries }
    await onExchange(payload, response)
    return response
  }
  const withGraph = (use, signal = new AbortController().signal) =>
    f.ports.source.withReadonlySource(f.manifest, f.source.admittedRootKey,
      (source, database, physicalSourceRecheck) => withHeldRetainedCatalogGraph(f.ports,
        { source, database, physicalSourceRecheck, captureGeneration: capture.generation,
          recheckLocalConsent: () => onLocalRecheck() }, use, signal))
  return { ...f, capture, authority, state, pages, exchanges, withGraph,
    select: value => { selection = value }, revoke: () => { revision++ },
    onExchange: callback => { onExchange = callback },
    onLocalRecheck: callback => { onLocalRecheck = callback },
    close: () => { executorApi.publishT3Catalog = original; f.close() } }
}
