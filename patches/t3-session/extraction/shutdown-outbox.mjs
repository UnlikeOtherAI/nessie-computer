/** Share the actual physical-row reader and constrain only prepared restart
 * inserts. The fence restricts SQL; it supplies no lifecycle permission. */
export const extractShutdownOutbox = author => {
  const file = 'apps/server/src/orchestration-v2/EffectOutbox.ts'
  author.replace(file, 'import type * as Scope from "effect/Scope";',
    'import type * as Scope from "effect/Scope";\nimport type { Fragment } from "effect/sql/Statement";',
    'shutdown-outbox-physical-selection-type')
  const reader = author.between(file, '    const readProcessLossRows = Effect.gen(function* () {',
    '    type ProcessLossPlan =')
  author.replace(file, reader, reader.replace('const readProcessLossRows = Effect.gen(function* () {',
    'const readPhysicalEffectRows = (selection: Fragment) => Effect.gen(function* () {')
    .replaceAll('${processLossSelection}', '${selection}')
    + '    const readProcessLossRows = readPhysicalEffectRows(processLossSelection);\n',
  'shutdown-outbox-share-physical-row-reader')
  author.replace(file, 'export interface EffectOutboxV2Shape {', `/** A SQL restriction, never admission to insert these effects. */
export class RestartContinuationWriteFence extends Context.Reference<
  OrchestrationEffectClaimDeadline & { readonly effectIds: ReadonlyArray<string> } | undefined
>("nessie/session-engine/RestartContinuationWriteFence", { defaultValue: () => undefined }) {}

export interface EffectOutboxV2Shape {
  /** Readonly exact physical slots for the original shutdown planner. */
  readonly inspectRestartContinuationSlots: (effects: ReadonlyArray<PendingOrchestrationEffectV2>) =>
    Effect.Effect<ReadonlyArray<{ readonly effectId: string; readonly rowDigest: string | null }>, EffectOutboxError>;`,
  'shutdown-outbox-slot-api-and-restrictive-fence')
  author.replace(file, '    const service: EffectOutboxV2Shape = {', `    const service: EffectOutboxV2Shape = {
      inspectRestartContinuationSlots: (effects) => Effect.gen(function* () {
        const expected = yield* Effect.try({ try: () => {
          if (effects.length > 256 || new Set(effects.map(effect => effect.id)).size !== effects.length
            || effects.some(effect => !effect.id || effect.availableAt !== undefined
              || effect.request.type !== "provider-runtime.continue")) throw new Error("shutdown-slots-input");
          return effects.map(effect => ({ id: effect.id, commandId: effect.commandId, threadId: effect.threadId,
            payload: encodeRequest(effect.request) }));
        }, catch: () => new EffectOutboxError({ operation: "shutdown-slots-input" }) });
        const ids = expected.map(effect => effect.id);
        const rows = yield* readPhysicalEffectRows(ids.length === 0 ? sql\`0 = 1\` : sql\`effect_id IN \${sql.in(ids)}\`);
        const byId = new Map(rows.map(row => [row.effect_id, row]));
        return yield* Effect.forEach(expected, effect => Effect.gen(function* () {
          const row = byId.get(effect.id);
          if (row && (row.command_id !== effect.commandId || row.thread_id !== effect.threadId
            || row.effect_type !== "provider-runtime.continue" || row.payload_json !== effect.payload)) {
            return yield* new EffectOutboxError({ operation: "shutdown-slot-conflict" });
          }
          return Object.freeze({ effectId: effect.id, rowDigest: row ? digestEffectRow(row) : null });
        }));
      }).pipe(NodeSqliteClient.readOnly, Effect.withTracerEnabled(false),
        Effect.mapError(cause => new EffectOutboxError({ operation: "inspect-shutdown-slots", cause }))),`,
  'shutdown-outbox-exact-existing-slots')
  const enqueue = author.between(file, '      enqueue: Effect.fn("EffectOutbox.enqueue")(', '      get: (effectId) =>')
  const guarded = enqueue.replace('          const now = yield* DateTime.now;', `          const fence = yield* RestartContinuationWriteFence;
          if (fence && effects.some(effect => effect.request.type !== "provider-runtime.continue"
            || !fence.effectIds.includes(effect.id))) {
            return yield* new EffectOutboxError({ operation: "shutdown-enqueue-scope" });
          }
          const now = yield* DateTime.now;`)
    .replace('              VALUES (', '              SELECT')
    .replace('                ${nowIso}\n              )\n              ON CONFLICT', `                \${nowIso}
              WHERE \${fence === undefined ? sql\`1 = 1\` : sql\`\${claimSchemaPredicate}
                AND CAST(unixepoch('subsec') * 1000 AS INTEGER) < \${fence.notAfterMs}
                AND nessie_t3_monotonic_now() < \${fence.notAfterMonotonicMs}\`}
              ON CONFLICT`)
  author.replace(file, enqueue, guarded, 'shutdown-outbox-actual-insert-deadline')
}
