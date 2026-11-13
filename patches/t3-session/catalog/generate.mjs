import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPatchAuthor } from '../extraction/author.mjs'

const file = 'apps/server/src/orchestration-v2/ProjectionStore.ts'
const revision = '25bf84ab07f53f141c20239c63e383823a9d5ea0'

/** Narrow adapter input, not an RPC schema change or a replacement selector.
 * The original cursor predicate, counts, SQL collation and ordering stay exact.
 */
export function generateCatalogManifest(snapshot) {
  if (snapshot.identity.commit !== revision) throw new Error('T3_CATALOG_SOURCE_REVISION_MISMATCH')
  const author = createPatchAuthor(snapshot)
  author.replace(file, '  readonly listActiveShellIndex: () => Effect.Effect<',
    '  readonly listActiveShellIndex: (threadIds?: ReadonlyArray<ThreadId>) => Effect.Effect<',
    'catalog-entitled-active-index-query')
  author.replace(file, '    const listActiveShellIndex = Effect.fn("ProjectionStore.listActiveShellIndex")(function* () {',
    '    const listActiveShellIndex = Effect.fn("ProjectionStore.listActiveShellIndex")(function* (threadIds?: ReadonlyArray<ThreadId>) {',
    'catalog-entitled-active-index-input')
  author.replace(file, "          AND json_extract(t.payload_json, '$.archivedAt') IS NULL\n        ORDER BY t.updated_at ASC, t.thread_id ASC",
    "          AND json_extract(t.payload_json, '$.archivedAt') IS NULL${\n"
      + '            threadIds === undefined ? sql``\n'
      + '              : sql` AND t.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))`\n'
      + '          }\n        ORDER BY t.updated_at ASC, t.thread_id ASC', 'catalog-entitled-active-index-predicate')
  author.replace(file, 'export interface OlderSettledThreadsQuery {',
    'export const RETAINED_CATALOG_THREAD_FILTER_VERSION = 1;\n\nexport interface OlderSettledThreadsQuery {\n'
      + '  readonly threadIds?: ReadonlyArray<ThreadId> | undefined;', 'catalog-entitled-thread-query')
  author.replace(file, '    )(function* ({ before, projectIds, limit }) {',
    '    )(function* ({ before, projectIds, threadIds, limit }) {', 'catalog-entitled-thread-input')
  const boundary = "          AND json_extract(t.payload_json, '$.settledAt') IS NOT NULL${"
  author.replace(file, boundary,
    boundary + '\n            threadIds === undefined ? sql``\n'
      + '              : sql` AND t.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))`\n'
      + '          }${', 'catalog-entitled-thread-predicate-before-cursor-count-limit')
  return { format: 1, sourceCommit: revision, patches: author.patches }
}

const main = () => {
  const repository = process.argv[2]
  if (!repository) throw new Error('An explicit read-only Git object store is required.')
  const bytes = execFileSync('git', ['-C', repository, 'show', `${revision}:${file}`], { maxBuffer: 4 * 1024 * 1024 })
  const lock = JSON.parse(readFileSync(new URL('../../../packaging/session-engine/source-lock.json', import.meta.url)))
  const tree = execFileSync('git', ['-C', repository, 'rev-parse', `${revision}^{tree}`], { encoding: 'utf8' }).trim()
  if (lock.commit !== revision || tree !== lock.tree) throw new Error('T3_CATALOG_SOURCE_IDENTITY_MISMATCH')
  const manifest = generateCatalogManifest({ identity: { commit: revision }, files: [file], read: requested => {
    if (requested !== file) throw new Error('T3_CATALOG_UNEXPECTED_SOURCE')
    return bytes
  } })
  writeFileSync(new URL('./boundary-patches.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${manifest.patches.length} source/hash-bound catalog operations\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
