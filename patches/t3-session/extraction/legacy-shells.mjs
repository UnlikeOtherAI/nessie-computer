import { legacyShellOwner } from './legacy-shell-owner.mjs'

const range = (text, start, end) => {
  if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('Legacy shell seam changed')
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)))
}

/** Share the original readers and mutations before adding the finite whole
 * action. The ordinary importer keeps its original per-row transaction order. */
export const extractLegacyShellPlans = author => {
  const directory = 'apps/server/src/orchestration-v2/'
  const search = `${directory}messageSearchIndex.ts`
  const triggers = author.between(search, 'export const createMessageSearchTriggers =', '/**\n * Refills the search index')
  const statements = [...triggers.matchAll(/yield\* (sql`[\s\S]*?`);/gu)].map(match => match[1])
  if (statements.length !== 3) throw new Error('Original search trigger statements changed')
  author.replace(search, triggers, `export const messageSearchTriggerStatements = (sql: SqlClient.SqlClient) => [
${statements.join(',\n')}
];
export const createMessageSearchTriggers = Effect.fn("MessageSearchIndex.createTriggers")(
  function* (sql: SqlClient.SqlClient) {
    for (const statement of messageSearchTriggerStatements(sql)) yield* statement;
  },
);

`, 'legacy-shell-share-original-search-trigger-ddl')

  const file = `${directory}legacy/LegacyV1ThreadImporter.ts`
  const owner = `${directory}legacy/LegacyShellReconciliation.ts`
  author.add(owner, legacyShellOwner, 'legacy-shell-finite-whole-action-owner')
  author.replace(file, 'export interface LegacyV1ThreadImporterShape {', `export type { LegacyShellReconciliationCandidate, LegacyShellTarget } from "./LegacyShellReconciliation.ts";
export interface LegacyV1ThreadImporterShape {
  readonly prepareShellReconciliation: Effect.Effect<LegacyShellReconciliationCandidate, LegacyV1ThreadImportError, Scope.Scope>;
  readonly reconcileShellsPrepared: (input: { readonly candidate: LegacyShellReconciliationCandidate }
    & NodeSqliteClient.SqliteStatementDeadline) => Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;`,
  'legacy-shell-plan-service-interface')
  author.replace(file, 'import * as Effect from "effect/Effect";', `import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { makeLegacyShellReconciliation, type LegacyShellReconciliationCandidate,
  type LegacyShellTarget } from "./LegacyShellReconciliation.ts";
import { messageSearchTriggerStatements } from "../messageSearchIndex.ts";`, 'legacy-shell-plan-imports')
  const original = author.between(file, '  const reconcileShellsBase =', '  const reconcileShells =')
  const repairRead = range(original, '    const repairRows = yield* ', '    let repairedThreadCount = 0;')
    .replace('    const repairRows = yield* ', '').trim().replace(/;$/u, '')
  const importRead = range(original, '    const rows = yield* ', '    let importedThreadCount = repairedThreadCount;')
    .replace('    const rows = yield* ', '').trim().replace(/;$/u, '')
  const repair = range(original, '      const decoded = decodeStoredThread(row.payload_json);',
    '      repairedThreadCount += 1;').replace('if (Option.isNone(decoded)) continue;',
    'if (Option.isNone(decoded)) return false;')
  const importing = range(original, '      const thread = importedThread(row);', '      importedThreadCount += 1;')
    .replace('      const previews = yield* listShellMessages(thread.id);\n', '')
  const helpers = `  const readShellRepairRows = ${repairRead};
  const readShellImportRows = ${importRead};
  const repairShellRow = (row: LegacyRepairRow, now: string) => Effect.gen(function* () {
${repair}    return true;
  });
  const importShellRow = (row: LegacyThreadRow, previews: ReadonlyArray<LegacyMessageRow>, now: string) =>
    Effect.gen(function* () {
${importing}      return previews.length;
    });
  const reconcileShellsBase = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    let importedThreadCount = 0, importedMessageCount = 0;
    for (const row of yield* readShellRepairRows) if (yield* repairShellRow(row, now)) importedThreadCount++;
    for (const row of yield* readShellImportRows) {
      importedMessageCount += yield* importShellRow(row, yield* listShellMessages(ThreadId.make(row.thread_id)), now);
      importedThreadCount++;
    }
    return { importedThreadCount, importedMessageCount };
  });

`
  author.replace(file, original, helpers, 'legacy-shell-share-original-reads-and-mutations')
  author.replace(file, '  const reconcileShells = reconcileShellsBase.pipe(', `  const shellPlanError = (reason: string) =>
    new LegacyV1ThreadImportError({ operation: "shell-plan", cause: reason });
  const mapShellPlanError = (cause: unknown) => cause instanceof LegacyV1ThreadImportError ? cause
    : new LegacyV1ThreadImportError({ operation: "shell-plan", cause });
  const readShellSchema = Effect.gen(function* () {
    const schema = yield* sql<{ readonly type: string; readonly name: string;
      readonly tbl_name: string; readonly sql: string | null }>
      \`SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type COLLATE BINARY, name COLLATE BINARY\`;
    const temporary = yield* sql\`SELECT type, name, tbl_name, sql FROM sqlite_temp_schema
      ORDER BY type COLLATE BINARY, name COLLATE BINARY\`;
    if (temporary.length > 0 || schema.length > 1024) return yield* shellPlanError("shell-plan-schema");
    const expected = new Map(messageSearchTriggerStatements(sql).map(statement => {
      const [text, parameters] = statement.compile();
      if (parameters.length) throw shellPlanError("shell-plan-trigger-parameters");
      const name = /CREATE TRIGGER (\\w+)/u.exec(text)?.[1];
      if (!name) throw shellPlanError("shell-plan-trigger-name");
      return [name, text.trim()] as const;
    }));
    for (const row of schema) if (row.type === "trigger"
      && (row.tbl_name !== "orchestration_v2_projection_messages"
        || expected.get(row.name) !== row.sql?.trim())) return yield* shellPlanError("shell-plan-trigger");
    for (const name of ["projection_threads", "projection_thread_messages", "projection_thread_pull_requests",
      "orchestration_events", "orchestration_v2_legacy_imports", "orchestration_v2_projection_threads",
      "orchestration_v2_turn_item_positions"]) {
      const row = schema.find(row => row.name === name);
      if (!row || row.type !== "table" || !/^CREATE TABLE\\s/iu.test(row.sql ?? "")) {
        return yield* shellPlanError("shell-plan-table");
      }
    }
    const foreign = yield* sql\`SELECT owned.name, reference.\"table\" AS target
      FROM sqlite_schema AS owned JOIN pragma_foreign_key_list(owned.name) AS reference
      WHERE owned.type = 'table' AND (owned.name LIKE 'orchestration_%' OR owned.name LIKE 'projection_%'
        OR reference.\"table\" LIKE 'orchestration_%' OR reference.\"table\" LIKE 'projection_%') LIMIT 1\`;
    if (foreign.length) return yield* shellPlanError("shell-plan-foreign-key");
    return schema;
  }).pipe(Effect.mapError(mapShellPlanError));
  const readShellInputs = Effect.gen(function* () {
    const schema = yield* readShellSchema;
    const repairRows = yield* readShellRepairRows;
    const importRows = yield* readShellImportRows;
    if (repairRows.length + importRows.length > 256) return yield* shellPlanError("shell-plan-size");
    const targets: Array<LegacyShellTarget> = [];
    const validId = (value: string) => Buffer.byteLength(value, "utf8") > 0
      && Buffer.byteLength(value, "utf8") <= 256 && !/[\\u0000-\\u001f\\u007f]/u.test(value);
    for (const row of repairRows) {
      const current = decodeStoredThread(row.payload_json);
      if (Option.isNone(current) || current.value.id !== row.thread_id
        || !validId(current.value.id) || !validId(current.value.projectId)) {
        return yield* shellPlanError("shell-plan-projection");
      }
      targets.push({ action: "repair", threadId: current.value.id, projectId: current.value.projectId });
    }
    const imports: Array<{ readonly row: LegacyThreadRow; readonly previews: ReadonlyArray<LegacyMessageRow> }> = [];
    for (const row of importRows) {
      if (!validId(row.thread_id) || !validId(row.project_id)) return yield* shellPlanError("shell-plan-target");
      targets.push({ action: "import", threadId: ThreadId.make(row.thread_id), projectId: ProjectId.make(row.project_id) });
      imports.push({ row, previews: yield* listShellMessages(ThreadId.make(row.thread_id)) });
    }
    const ids = [...new Set(targets.map(target => target.threadId))];
    const selection = ids.length ? sql\`thread_id IN \${sql.in(ids)}\` : sql\`0 = 1\`;
    const positions = yield* sql\`SELECT * FROM orchestration_v2_turn_item_positions WHERE \${selection}
      ORDER BY thread_id COLLATE BINARY, turn_item_id COLLATE BINARY\`;
    const legacy = yield* sql\`SELECT * FROM orchestration_v2_legacy_imports WHERE \${selection}
      ORDER BY thread_id COLLATE BINARY\`;
    const projected = yield* sql\`SELECT * FROM orchestration_v2_projection_threads WHERE \${selection}
      ORDER BY thread_id COLLATE BINARY\`;
    const eventTargets = imports.flatMap(({ row, previews }) => [
      \`\${IMPORT_EVENT_PREFIX}:thread:\${row.thread_id}:created\`,
      ...previews.flatMap(messageEvents).map(event => event.id),
      \`\${IMPORT_EVENT_PREFIX}:thread:\${row.thread_id}:shell\`,
    ].map(eventId => [eventId, row.thread_id] as const));
    const eventOwners = new Map(eventTargets);
    if (eventOwners.size !== eventTargets.length) return yield* shellPlanError("shell-plan-duplicate-event-slot");
    const eventIds = [...eventOwners.keys()];
    const eventSelection = eventIds.length ? sql\`event_id IN \${sql.in(eventIds)}\` : sql\`0 = 1\`;
    const events = yield* sql<{ readonly event_id: string; readonly aggregate_kind: string; readonly stream_id: string;
      readonly application_event_version: number }>\`SELECT * FROM orchestration_events WHERE \${eventSelection}
      ORDER BY event_id COLLATE BINARY\`;
    if (events.some(event => event.aggregate_kind !== "thread" || event.application_event_version !== 2
      || eventOwners.get(event.event_id) !== event.stream_id)) return yield* shellPlanError("shell-plan-event-target");
    return { inputs: { schema, repairRows, imports, positions, legacy, projected, events }, targets };
  }).pipe(Effect.mapError(mapShellPlanError));
  const writeShellInputs = (inputs: Effect.Success<typeof readShellInputs>["inputs"]) => Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    let importedThreadCount = 0, importedMessageCount = 0;
    for (const row of inputs.repairRows) if (yield* repairShellRow(row, now)) importedThreadCount++;
    for (const { row, previews } of inputs.imports) {
      importedMessageCount += yield* importShellRow(row, previews, now);
      importedThreadCount++;
    }
    return { importedThreadCount, importedMessageCount };
  }).pipe(Effect.mapError(mapShellPlanError));
  const { prepareShellReconciliation, reconcileShellsPrepared } =
    makeLegacyShellReconciliation(sql, eventSink, readShellInputs, writeShellInputs, readShellSchema);

  const reconcileShells = reconcileShellsBase.pipe(`, 'legacy-shell-whole-plan-reads-and-conditional-write')
  author.replace(file, '    reconcileShells,\n',
    '    reconcileShells,\n    prepareShellReconciliation,\n    reconcileShellsPrepared,\n',
    'legacy-shell-expose-scoped-plan')
}
