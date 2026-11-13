/** Fixed reads from T3 25bf84ab; never SELECT * or enumerate a person's directories.
 * Migration names and exact column selections are checked against committed objects.
 * Extra tables are ignored. Missing columns/tables, views and divergent migrations fail.
 */
export interface CaptureTable {
  readonly name: string
  readonly columns: readonly string[]
  readonly order: string
  readonly where?: string
  readonly codec?: string
  readonly scope?: string
}
// One fixed column catalogue serves both the importer and native SQLite reader.
import definitions from '../source/tables.json' with { type: 'json' }
const entries: readonly CaptureTable[] = Object.freeze(definitions.map(entry => Object.freeze({
  ...entry, columns: Object.freeze(entry.columns),
})))
export const legacyThreads = entries[0]!
export const legacyMessages = entries[1]!
export const legacyPullRequests = entries[2]!
export const projectTable = entries[3]!
export const v2Tables: readonly CaptureTable[] = Object.freeze(entries.slice(4))

// Only legacy rows needed by the original importer, from this same authoritative file.
const legacyEligible = `thread_id IN (SELECT thread_id FROM projection_threads AS legacy WHERE
  NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS current WHERE current.thread_id = legacy.thread_id)
  OR EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports AS imported WHERE imported.thread_id = legacy.thread_id))`
export const tablesForLayout = (layout: 'v2-80' | 'legacy-54'): readonly CaptureTable[] => Object.freeze([
  layout === 'v2-80' ? Object.freeze({ ...projectTable,
    columns: Object.freeze([...projectTable.columns, 'pinned_at', 'archived_at']) }) : projectTable,
  ...(layout === 'v2-80' ? v2Tables : []),
  ...[legacyThreads, legacyMessages, legacyPullRequests].map(entry => layout === 'v2-80'
    ? Object.freeze({ ...entry, where: legacyEligible }) : entry),
])

export const selectCaptureRows = (entry: CaptureTable): string =>
  `SELECT ${entry.columns.join(', ')} FROM ${entry.name}${entry.where ? ` WHERE ${entry.where}` : ''} ORDER BY ${entry.order}`
