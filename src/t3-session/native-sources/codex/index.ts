export { codexIdentity, codexIdentityKey, codexAssociationCandidates, CodexSourceFailure } from './identity.js'
export type { CodexHomeIdentity, CodexNativeIdentity, CodexT3Association } from './identity.js'
export { readCodexIndexPage } from './index-reader.js'
export type { CodexIndexDatabase, CodexIndexEntry, CodexIndexCursor } from './index-reader.js'
export { CodexRetainedCatalog } from './catalog.js'
export type { CodexCatalogRow, CodexCatalogCursor, CodexInventoryPart } from './catalog.js'
export { CodexRetainedHistory } from './history.js'
export type { CodexRolloutBytes, CodexHistoryCursor, CodexHistoryEntry } from './history.js'

/** Not an advertisement. No producer may infer admission from these data-plane exports. */
export const codexRetainedSourceBindings = Object.freeze({
  physicalNativeHistoryProducer: 'required_unbound',
  originalHumanReadProducer: 'required_unbound',
  threeSourceCatalogPublication: 'required_unbound',
  toolRegistration: 'required_unbound',
  execution: 'unavailable',
} as const)
