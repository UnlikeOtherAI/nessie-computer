import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3CatalogMetadataPageSchema, T3CatalogPublicationSchema, T3CatalogPublicationReceiptSchema,
  type T3CatalogMetadataPage, type T3CatalogPublication } from '@nessie/executor-protocol/t3-session'
import { executorApi } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/** Signed transport only. The held capture producer supplies original ordered
 * metadata and the prospective publish grant. No read lease or local pathname
 * becomes publication authority; the backend consumes its own native-verified
 * current grant before every page and completion.
 */
export function createT3CatalogPublicationTransport(state: () => ExecutorLocalState,
  grantId: string, value: T3CatalogPublication) {
  const publication = T3CatalogPublicationSchema.parse(value)
  const initial = state()
  const identity = (current: ExecutorLocalState) => canonicalExecutorJson({ executorId: current.executorId,
    connectionEpoch: current.connectionEpoch, apiBaseUrl: current.apiBaseUrl, machinePublicKey: current.machinePublicKey })
  const identityKey = identity(initial)
  const send = async (page: T3CatalogMetadataPage | undefined, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const current = state()
    if (!current.connectionEpoch || identity(current) !== identityKey) throw new Error('T3_PUBLICATION_FENCED')
    const operation = page ? { operation: 't3.catalog.page' as const, page }
      : { operation: 't3.catalog.complete' as const }
    const payload = { executorId: current.executorId, connectionEpoch: current.connectionEpoch,
      observedAt: new Date().toISOString(), grantId, publication, ...operation }
    const result = await executorApi.publishT3Catalog(current.apiBaseUrl, { ...payload,
      signature: signExecutorDaemonPayload(current.machinePrivateKey, 't3_catalog', payload) }, { signal })
    signal?.throwIfAborted()
    if (identity(state()) !== identityKey) throw new Error('T3_PUBLICATION_FENCED')
    const receipt = T3CatalogPublicationReceiptSchema.parse(result)
    if (receipt.captureGeneration !== publication.captureGeneration || receipt.selectionKey !== publication.selectionKey
      || receipt.totalEntries !== publication.totalEntries || receipt.totalPages !== publication.totalPages
      || page && (receipt.nextPage < page.pageOrdinal + 1 || receipt.nextEntry < page.firstEntry + page.entries.length)
      || !page && receipt.state !== 'complete') throw new Error('T3_PUBLICATION_RECEIPT_MISMATCH')
    return receipt
  }
  return {
    page: (page: T3CatalogMetadataPage, signal?: AbortSignal) => send(T3CatalogMetadataPageSchema.parse(page), signal),
    complete: (signal?: AbortSignal) => send(undefined, signal),
  }
}
