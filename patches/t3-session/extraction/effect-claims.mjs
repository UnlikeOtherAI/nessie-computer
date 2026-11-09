/** Read a real pending row before admission; consume that same scoped snapshot
 * once with a conditional update. A candidate is data, never permission. */
export const extractEffectClaims = author => {
  const sqlite = 'packages/shared/src/nodeSqliteClient.ts'
  author.replace(sqlite, 'import * as NodeSqlite from "node:sqlite";',
    'import { performance as nodePerformance } from "node:perf_hooks";\nimport * as NodeSqlite from "node:sqlite";',
    'effect-claim-monotonic-sql-import')
  const checkpoint = '    // Started after the close finalizer, so the worker stops before the writer closes.'
  author.replace(sqlite, checkpoint, `    // Non-deterministic and direct-only: evaluated by the actual claim VDBE,
    // after connection/write-lock waits, independently of wall-clock rollback.
    db.function("nessie_t3_monotonic_now", { deterministic: false, directOnly: true }, () => nodePerformance.now());
${checkpoint}`, 'effect-claim-monotonic-sql-function')
  const file = 'apps/server/src/orchestration-v2/EffectOutbox.ts'
  const first = author.read(file).match(/^import[^;]+;/u)[0]
  author.replace(file, first,
    `import { createHash } from "node:crypto";\nimport { performance } from "node:perf_hooks";\nimport type * as Scope from "effect/Scope";\n${first}`,
    'effect-claim-scope-import')
  author.replace(file, '  readonly lease_owner: string | null;',
    '  readonly lease_owner: string | null;\n  readonly lease_expires_at: string | null;',
    'effect-claim-retain-physical-lease-expiry')
  author.replace(file, 'export interface EffectOutboxV2Shape {', `declare const effectClaimCandidateBrand: unique symbol;
/** Opaque read snapshot, valid only in its preparing Scope and original outbox.
 * It cannot authorize a SQL transition, provider or native frame. */
export interface OrchestrationEffectClaimCandidate {
  readonly [effectClaimCandidateBrand]: true;
  readonly effect: OrchestrationEffectV2;
  /** Hash of all physical SQL fields, including the legacy lease-expiry column.
   * This reveals no raw payload/error and grants no mutation authority. */
  readonly rowDigest: string;
}

export interface OrchestrationEffectClaimDeadline {
  readonly notAfterMs: number;
  readonly notAfterMonotonicMs: number;
}
export interface EffectOutboxV2Shape {
  readonly prepareClaim: (input: {
    readonly workerId: string;
    readonly commandIds: ReadonlyArray<CommandId>;
    readonly excludeRestartContinuations?: boolean;
  }) => Effect.Effect<Option.Option<OrchestrationEffectClaimCandidate>, EffectOutboxError, Scope.Scope>;
  /** Low-level conditional SQL only. The protected worker must acquire actual
   * current admission before supplying its original absolute expiry here. */
  readonly claimPrepared: (input: {
    readonly candidate: OrchestrationEffectClaimCandidate;
  } & OrchestrationEffectClaimDeadline) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>;
  readonly nextClaimableAtForCommands: (commandIds: ReadonlyArray<CommandId>) =>
    Effect.Effect<Option.Option<DateTime.Utc>, EffectOutboxError>;`, 'effect-claim-candidate-api')

  const beforeSignal = '    const cancellationSignal = (effectId: string) => {'
  author.replace(file, beforeSignal, `    const selectClaimable = (availableBefore?: string,
      excludeRestartContinuations = false, commandIds?: ReadonlyArray<CommandId>) => sql\`
        SELECT candidate.effect_id
        FROM orchestration_v2_effect_outbox AS candidate
        WHERE \${claimableCandidatePredicate(availableBefore, excludeRestartContinuations)}
          AND \${excludeRestartContinuations ? sql\`candidate.effect_type != 'provider-runtime.continue'\` : sql\`1 = 1\`}
          AND \${commandIds === undefined ? sql\`1 = 1\` : sql\`candidate.command_id IN \${sql.in(commandIds)}\`}
        ORDER BY candidate.available_at ASC, candidate.created_at ASC, candidate.effect_id ASC
        LIMIT 1
      \`;
    const claimColumns = ["effect_id", "command_id", "thread_id", "effect_type", "payload_json", "status",
      "attempt_count", "available_at", "lease_owner", "lease_expires_at", "created_at", "updated_at",
      "completed_at", "last_error"] as const satisfies ReadonlyArray<keyof EffectRow>;
    // Cached SELECT * column metadata can hide a later ALTER TABLE. Read live
    // schema rows and repeat this predicate in the actual selection/transition.
    const claimSchemaPredicate = sql\`
      EXISTS (SELECT 1 FROM sqlite_schema WHERE name = 'orchestration_v2_effect_outbox'
        AND type = 'table' AND substr(upper(sql), 1, 13) = 'CREATE TABLE ')
      AND NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'orchestration_v2_effect_outbox')
      AND (SELECT json_group_array(name) FROM (
        SELECT name FROM pragma_table_xinfo('orchestration_v2_effect_outbox') ORDER BY cid
      )) = \${JSON.stringify(claimColumns)}
      AND NOT EXISTS (SELECT 1 FROM pragma_table_xinfo('orchestration_v2_effect_outbox') WHERE hidden != 0)
    \`;
    const checkedCommands = (values: ReadonlyArray<CommandId>) => Effect.try({ try: () => {
      const copied = [...values];
      if (copied.length > 64 || new Set(copied).size !== copied.length
        || copied.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("Invalid claim scope");
      return Object.freeze(copied);
    }, catch: () => new EffectOutboxError({ operation: "prepare-claim" }) });
    type PreparedClaim = {
      readonly row: Readonly<EffectRow>;
      readonly effect: OrchestrationEffectV2;
      readonly workerId: string;
      readonly commandIds: ReadonlyArray<CommandId>;
      readonly excludeRestartContinuations: boolean;
    };
    const preparedClaims = new WeakMap<OrchestrationEffectClaimCandidate, PreparedClaim>();
    const claimKey = Object.freeze({});
    class ClaimCandidate implements OrchestrationEffectClaimCandidate {
      declare readonly [effectClaimCandidateBrand]: true;
      constructor(key: object) {
        if (key !== claimKey) throw new EffectOutboxError({ operation: "prepare-claim" });
      }
      get effect(): OrchestrationEffectV2 {
        const prepared = preparedClaims.get(this);
        if (prepared === undefined) throw new EffectOutboxError({ operation: "claim-candidate-closed" });
        return structuredClone(prepared.effect);
      }
      get rowDigest(): string {
        const prepared = preparedClaims.get(this);
        if (prepared === undefined) throw new EffectOutboxError({ operation: "claim-candidate-closed" });
        return "sha256:" + createHash("sha256").update(JSON.stringify([
          "nessie.t3.pending-effect-row.v1", ...claimColumns.map(column => prepared.row[column]),
        ]), "utf8").digest("hex");
      }
    }
    Object.freeze(ClaimCandidate.prototype);

${beforeSignal}`, 'effect-claim-original-selection-and-owner')

  const selection = `              SELECT candidate.effect_id
              FROM orchestration_v2_effect_outbox AS candidate
              WHERE \${claimableCandidatePredicate(nowIso, excludeRestartContinuations)}
                AND \${excludeRestartContinuations ? sql\`candidate.effect_type != 'provider-runtime.continue'\` : sql\`1 = 1\`}
              ORDER BY candidate.available_at ASC, candidate.created_at ASC, candidate.effect_id ASC
              LIMIT 1`
  author.replace(file, selection, '              ${selectClaimable(nowIso, excludeRestartContinuations)}',
    'effect-claim-share-original-selection')

  const nextStart = '      nextClaimableAt: Effect.gen(function* () {'
  const nextEnd = '      succeed: Effect.fn("EffectOutbox.succeed")('
  const next = author.between(file, nextStart, nextEnd)
  const nextBody = next.replace(nextStart,
    '    const readNextClaimableAt = (commandIds?: ReadonlyArray<CommandId>) => Effect.gen(function* () {')
    .replace('WHERE ${claimableCandidatePredicate()}',
      'WHERE ${claimableCandidatePredicate()}\n'
      + '            AND ${commandIds === undefined ? sql`1 = 1` : sql`candidate.command_id IN ${sql.in(commandIds)}`}')
    .replace(/\),\n$/u, ');\n')
  author.replace(file, next, `      nextClaimableAt: readNextClaimableAt(),
      nextClaimableAtForCommands: (commandIds) => Effect.gen(function* () {
        const commands = yield* checkedCommands(commandIds);
        return commands.length === 0 ? Option.none() : yield* readNextClaimableAt(commands);
      }),
`, 'effect-claim-scoped-next-deadline')
  author.replace(file, '    const service: EffectOutboxV2Shape = {', `${nextBody}
    const service: EffectOutboxV2Shape = {
      prepareClaim: Effect.fn("EffectOutbox.prepareClaim")(function* (input) {
        const commandIds = yield* checkedCommands(input.commandIds);
        if (commandIds.length === 0) return Option.none();
        const excludeRestartContinuations = input.excludeRestartContinuations ?? false;
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const schema = yield* sql<{ readonly recognized: number }>\`
          SELECT \${claimSchemaPredicate} AS recognized
        \`.pipe(NodeSqliteClient.readOnly, Effect.withTracerEnabled(false));
        if (schema[0]?.recognized !== 1) return yield* new EffectOutboxError({ operation: "prepare-claim-schema" });
        const rows = yield* sql<EffectRow>\`
          SELECT * FROM orchestration_v2_effect_outbox
          WHERE effect_id = (\${selectClaimable(nowIso, excludeRestartContinuations, commandIds)})
            AND \${claimSchemaPredicate}
        \`.pipe(NodeSqliteClient.readOnly, Effect.withTracerEnabled(false));
        const row = rows[0];
        if (row === undefined) return Option.none();
        if (Object.keys(row).length !== claimColumns.length || claimColumns.some(column => !Object.hasOwn(row, column))) {
          return yield* new EffectOutboxError({ operation: "prepare-claim-schema" });
        }
        const effect = yield* rowToEffect(row);
        const candidate: OrchestrationEffectClaimCandidate = Object.freeze(new ClaimCandidate(claimKey));
        preparedClaims.set(candidate, { row: Object.freeze({ ...row }), effect, workerId: input.workerId,
          commandIds, excludeRestartContinuations });
        yield* Effect.addFinalizer(() => Effect.sync(() => { preparedClaims.delete(candidate); }));
        return Option.some(candidate);
      }, Effect.mapError((cause) => new EffectOutboxError({ operation: "prepare-claim", cause }))),
      claimPrepared: Effect.fn("EffectOutbox.claimPrepared")(function* ({ candidate, notAfterMs, notAfterMonotonicMs }) {
        const prepared = preparedClaims.get(candidate);
        if (prepared === undefined) return yield* new EffectOutboxError({ operation: "claim-prepared" });
        // Consume before any asynchronous SQL. Scope expiry, uncertainty and a
        // failed conditional update cannot extend or retry this candidate.
        preparedClaims.delete(candidate);
        const observedNow = Date.now();
        const observedMonotonic = performance.now();
        if (!Number.isSafeInteger(notAfterMs) || notAfterMs <= observedNow || notAfterMs > observedNow + 5_000
          || !Number.isFinite(notAfterMonotonicMs) || notAfterMonotonicMs <= observedMonotonic
          || notAfterMonotonicMs > observedMonotonic + 5_000) {
          return yield* new EffectOutboxError({ operation: "claim-prepared-expired" });
        }
        const expected = prepared.row;
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql<EffectRow>\`
          UPDATE orchestration_v2_effect_outbox
          SET status = 'running', attempt_count = attempt_count + 1,
            lease_owner = \${prepared.workerId}, updated_at = \${nowIso}, last_error = NULL
          WHERE effect_id = \${expected.effect_id}
            AND \${claimSchemaPredicate}
            AND effect_id = (\${selectClaimable(nowIso, prepared.excludeRestartContinuations, prepared.commandIds)})
            AND command_id = \${expected.command_id} AND thread_id = \${expected.thread_id}
            AND effect_type = \${expected.effect_type} AND payload_json = \${expected.payload_json}
            AND status = 'pending' AND attempt_count = \${expected.attempt_count}
            AND available_at = \${expected.available_at} AND lease_owner IS \${expected.lease_owner}
            AND lease_expires_at IS \${expected.lease_expires_at}
            AND created_at = \${expected.created_at} AND updated_at = \${expected.updated_at}
            AND completed_at IS \${expected.completed_at} AND last_error IS \${expected.last_error}
            AND CAST(unixepoch('subsec') * 1000 AS INTEGER) < \${notAfterMs}
            AND nessie_t3_monotonic_now() < \${notAfterMonotonicMs}
          RETURNING *
        \`.pipe(Effect.withTracerEnabled(false));
        const row = rows[0];
        if (row === undefined) return Option.none();
        cancellationSignals.set(row.effect_id, Deferred.makeUnsafe<void>());
        return Option.some(yield* rowToEffect(row));
      }, Effect.mapError((cause) => new EffectOutboxError({ operation: "claim-prepared", cause }))),`,
  'effect-claim-prepare-and-conditional-transition')
}
