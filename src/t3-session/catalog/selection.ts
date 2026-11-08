import type { SourceContracts as S } from '@nessie/t3-session-source/engine'
import type { ProvenT3Source } from '../import/manifest.js'
import type { RetainedReadScope } from '../ownership/continuity.js'

/** Output of canonical source/import-grant selection, never request parameters.
 * A whole-environment owner and a thread recipient are different grants. Project
 * membership does not imply access to every thread in that project.
 */
export type RetainedCatalogSelection = {
  readonly basis: 'historical-continuity' | 'prospective-import-grant'
  readonly revision: string
} & ({ readonly scope: 'environment-owner' } | {
  readonly scope: 'threads'
  readonly threadIds: readonly S.ThreadId[]
  readonly projectIds: readonly S.ProjectId[]
})

export interface RetainedCatalogReadScope extends RetainedReadScope {
  readonly selection: RetainedCatalogSelection
  /** Revalidate the exact issued selection, source/import consent, selected team,
   * recipient and independent shares. A changed selection requires a new read.
   */
  recheckSelection(): Promise<void>
}

/** Implemented by the retained-owner grant producer. The producer recognizes
 * the physical source's exact issued callback and pins its actual current grant
 * selection. This declaration grants nothing and supplies no fallback producer.
 */
export interface RetainedCatalogAuthorityPort {
  withCatalogReadScope<A>(input: {
    readonly source: ProvenT3Source
    readonly physicalSourceRecheck: () => Promise<void>
    readonly captureGeneration: string
    readonly purpose: 'retained-catalog-read'
  }, use: (lease: RetainedCatalogReadScope) => Promise<A>): Promise<A>
}

/** Publication consent is distinct from permission to read a published catalog.
 * The canonical producer must recognize the exact held physical callback and
 * revalidate the source-owner import grant, current UOA admission and selection.
 */
export interface RetainedCatalogPublicationScope extends RetainedCatalogReadScope {
  readonly publicationGrantId: string
  readonly selectionKey: string
}

export interface RetainedCatalogPublicationAuthorityPort {
  withCatalogPublicationScope<A>(input: {
    readonly source: ProvenT3Source
    readonly physicalSourceRecheck: () => Promise<void>
    readonly captureGeneration: string
    readonly purpose: 'retained-catalog-publish'
  }, use: (lease: RetainedCatalogPublicationScope) => Promise<A>): Promise<A>
}

export const pinCatalogSelection = (selection: RetainedCatalogSelection): RetainedCatalogSelection =>
  selection.scope === 'environment-owner' ? Object.freeze({ ...selection })
    : Object.freeze({ ...selection, threadIds: Object.freeze([...new Set(selection.threadIds)]),
      projectIds: Object.freeze([...new Set(selection.projectIds)]) })
