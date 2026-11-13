import { selectedImports } from './author.mjs'

const file = 'apps/server/src/orchestration-v2/ProjectionStore.ts'
const start = '    const getRuntimeRecoveryProjection:'
const end = '    const getThread: ProjectionStoreV2Shape["getThread"]'
const between = (value, from, to) => {
  if (value.split(from).length !== 2 || value.split(to).length !== 2) throw Error('Recovery input seam changed')
  return value.slice(value.indexOf(from), value.indexOf(to, value.indexOf(from)))
}

/** Frozen SQL data for the independent reader. Parameters are only repetitions
 * of the selected thread ID; no supplied SQL or partial section set exists. */
export const recoveryInputQueries = text => {
  const operation = between(text, start, end)
  const thread = /const threadRows = yield\* sql<PayloadRow>`([\s\S]*?)`;/u.exec(operation)?.[1]
  const queries = between(operation, '          const queries = {', '          const sections =')
  const sections = [...queries.matchAll(/^            (\w+): sql<PayloadRow>`([\s\S]*?)`,/gmu)]
    .map(([, section, query]) => ({ section, query: query.replaceAll('${threadId}', '?'),
      parameters: query.split('${threadId}').length - 1 }))
  if (!thread || sections.length !== 10 || new Set(sections.map(value => value.section)).size !== 10
    || [thread, ...sections.map(value => value.query)].some(value => /\$\{(?!threadId\})/u.test(value))) {
    throw Error('Unsupported original recovery query')
  }
  const tables = [...new Set([...thread.matchAll(/\b(?:FROM|JOIN)\s+(orchestration_v2_\w+)/gu),
    ...sections.flatMap(value => [...value.query.matchAll(/\b(?:FROM|JOIN)\s+(orchestration_v2_\w+)/gu)])]
    .map(match => match[1]))].sort()
  const selection = between(text, '            case "restart-continuations":', '            case "runtime":')
  const restart = /return sql`([\s\S]*?)`;/u.exec(selection)?.[1]
  if (!restart || restart.includes('${')) throw Error('Unsupported original restart selection')
  const shutdownSelection = { parameters: 3, query: `SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND thread_id IN (${restart})
      AND (? = 'all' OR project_id IN (SELECT value FROM json_each(?)))
      AND project_id NOT IN (SELECT value FROM json_each(?))
    ORDER BY updated_at ASC, thread_id ASC` }
  return { version: 1, sourceCommit: '25bf84ab07f53f141c20239c63e383823a9d5ea0', tables, shutdownSelection,
    thread: { query: thread.replaceAll('${threadId}', '?'), parameters: 1 },
    sections: sections.sort((a, b) => a.section < b.section ? -1 : a.section > b.section ? 1 : 0) }
}

/** Move the actual original SELECTs before the independent observer reuses
 * them. The ordinary read keeps its decode ordering and existing error types. */
export const extractRecoveryInputs = (author, redirects) => {
  const target = file.replace('ProjectionStore.ts', 'RecoveryProjectionInputs.ts')
  const original = author.between(file, start, end)
  const restartCase = author.between(file, '            case "restart-continuations":', '            case "runtime":')
  const restartFragment = /return (sql`[\s\S]*?`);/u.exec(restartCase)?.[1]
  if (!restartFragment) throw Error('Original restart candidate fragment changed')
  const thread = between(original, '          const threadRows = yield* sql<PayloadRow>`',
    '          if (threadRows[0] === undefined)')
  const sections = between(original, '          const queries = {', '          const readRows =')
  const names = recoveryInputQueries(author.read(file)).sections.map(value => JSON.stringify(value.section)).join(' | ')
  const types = `type PayloadRow = { readonly payload_json: string };
export interface InputRow extends PayloadRow { readonly section: string; }
export type Section = ${names};
`
  const hash = `
/** Logical SQLite TEXT bytes in original section/row order, not decoded codec
 * output. This metadata proves no lifecycle or mutation permission. */
export const inputDigest = (threadId: string, threadPayload: string, rows: ReadonlyArray<InputRow>): string => {
  if (rows.length > 16384) throw Error("T3_RECOVERY_INPUT_LIMIT");
  const value = JSON.stringify(["nessie.t3.runtime-recovery-inputs.v1", threadId, threadPayload,
    rows.map(row => [row.section, row.payload_json])]);
  if (Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024) throw Error("T3_RECOVERY_INPUT_LIMIT");
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
};
`
  author.derive(target, [selectedImports(author.read(file), thread + sections + ' Effect ThreadId',
    file, target, redirects),
    'import { createHash } from "node:crypto";\nimport type * as SqlClient from "effect/sql/SqlClient";\n',
    types, 'export const readThread = (sql: SqlClient.SqlClient, threadId: ThreadId) => Effect.gen(function* () {\n',
    author.sourcePart(file, thread, { current: true }), '  return threadRows;\n});\n',
    'export const readSections = (sql: SqlClient.SqlClient, threadId: ThreadId) => Effect.gen(function* () {\n',
    author.sourcePart(file, sections, { current: true }), '  return rows;\n});\n',
    'export const restartCandidates = (sql: SqlClient.SqlClient) => ',
    author.sourcePart(file, restartFragment, { current: true }), ';\n', hash],
  'recovery-original-physical-input-queries')
  author.replace(file, restartCase, restartCase.replace(restartFragment, 'RecoveryInputs.restartCandidates(sql)'),
    'recovery-share-original-restart-candidate-query')
  author.replace(file, thread, '          const threadRows = yield* RecoveryInputs.readThread(sql, threadId);\n',
    'recovery-shared-thread-input-query')
  author.replace(file, sections, '          const rows = yield* RecoveryInputs.readSections(sql, threadId);\n',
    'recovery-shared-section-input-queries')
  author.replace(file, '          const readRows = (section: keyof typeof queries) =>',
    '          const readRows = (section: RecoveryInputs.Section) =>', 'recovery-shared-section-names')
  author.replace(file, '    const getRuntimeRecoveryProjection: ProjectionStoreV2Shape["getRuntimeRecoveryProjection"] =',
    `    const readRuntimeRecoveryProjection: (threadId: ThreadId) => Effect.Effect<{
      readonly projection: ProjectionRuntimeRecoveryState; readonly inputDigest: () => string;
    }, ProjectionStoreV2Error> =`, 'recovery-private-shared-projection-read')
  const result = author.between(file, '    const readRuntimeRecoveryProjection:', end)
  const resultStart = '          return {\n            thread,\n            runs,\n            attempts,'
  const before = '          } satisfies ProjectionRuntimeRecoveryState;'
  if (result.split(before).length !== 2 || result.split(resultStart).length !== 2) throw Error('Recovery result changed')
  author.replace(file, result, result.replace(resultStart,
    '          return { projection: {\n            thread,\n            runs,\n            attempts,')
    .replace(before, `          } satisfies ProjectionRuntimeRecoveryState,
            inputDigest: () => RecoveryInputs.inputDigest(threadId, threadRows[0]!.payload_json, rows) };`),
  'recovery-retain-private-physical-inputs')
  const shape = author.between(file, '  readonly getRuntimeRecoveryProjection: (',
    '  readonly getPendingNativeUserInputs: (')
  author.replace(file, shape, shape + shape.replace('getRuntimeRecoveryProjection:',
    'getRuntimeRecoveryProjectionWithInputs:').replace('Effect.Effect<ProjectionRuntimeRecoveryState,',
    'Effect.Effect<{ readonly projection: ProjectionRuntimeRecoveryState; readonly inputDigest: string },'),
  'recovery-physical-input-read-contract')
  author.replace(file, '      getRuntimeRecoveryProjection: readOnReader(getRuntimeRecoveryProjection),',
    `      getRuntimeRecoveryProjection: readOnReader((threadId: ThreadId) =>
        readRuntimeRecoveryProjection(threadId).pipe(Effect.map(value => value.projection))),
      getRuntimeRecoveryProjectionWithInputs: readOnReader((threadId: ThreadId) =>
        readRuntimeRecoveryProjection(threadId).pipe(Effect.flatMap(value => Effect.try({
          try: () => ({ projection: value.projection, inputDigest: value.inputDigest() }),
          catch: cause => new ProjectionStoreReadError({ threadId, cause }),
        })))),`, 'recovery-both-reads-share-original-constructor')
  const first = author.read(file).match(/^import[\s\S]*?;/u)[0]
  author.replace(file, first, `import * as RecoveryInputs from "./RecoveryProjectionInputs.ts";\n${first}`,
    'recovery-original-input-query-import')
}
