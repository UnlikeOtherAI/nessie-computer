/** Read and consume the actual complete global transition. A scoped candidate
 * describes physical SQL inputs; it never supplies lifecycle authority. */
export const extractProcessLossPlans = author => {
  const file = 'apps/server/src/orchestration-v2/EffectOutbox.ts'
  const digest = `        return "sha256:" + createHash("sha256").update(JSON.stringify([
          "nessie.t3.pending-effect-row.v1", ...claimColumns.map(column => prepared.row[column]),
        ]), "utf8").digest("hex");`
  author.replace(file, digest, '        return digestEffectRow(prepared.row);', 'process-loss-share-physical-row-digest')
  author.replace(file, 'import type * as Scope from "effect/Scope";',
    'import type * as Scope from "effect/Scope";\nimport * as Fiber from "effect/Fiber";',
    'process-loss-scoped-consumption-import')
  author.replace(file, 'export interface EffectOutboxV2Shape {', `declare const processLossCandidateBrand: unique symbol;
export interface OrchestrationProcessLossCandidate {
  readonly [processLossCandidateBrand]: true;
  readonly observedAtMs: number;
  readonly planDigest: string;
  readonly effects: ReadonlyArray<{ readonly effectId: string; readonly commandId: string;
    readonly threadId: string; readonly effectType: string; readonly rowDigest: string;
    readonly transition: "cancel" | "requeue" }>;
}
export interface EffectOutboxV2Shape {
  /** Complete readonly physical snapshot, not permission for its global targets. */
  readonly prepareProcessLoss: Effect.Effect<OrchestrationProcessLossCandidate, EffectOutboxError, Scope.Scope>;
  /** Low-level exact conditional transaction. A current lifecycle owner is still required. */
  readonly reconcilePreparedProcessLoss: (input: { readonly candidate: OrchestrationProcessLossCandidate }
    & OrchestrationEffectClaimDeadline) => Effect.Effect<{
      readonly requeued: number; readonly cancelled: number }, EffectOutboxError>;`, 'process-loss-plan-api')

  const original = author.between(file, '      reconcileAfterProcessLoss: sql.withTransaction(Effect.gen(function* () {',
    '      // The worker polls for the next effect even when there is no work to claim.')
  const shared = original.replace('      reconcileAfterProcessLoss:',
    '    const reconcileProcessLoss = (consumption?: ProcessLossConsumption) =>')
    .replace('        const now = DateTime.formatIso',
      '        if (consumption) yield* checkProcessLoss(consumption);\n        const now = DateTime.formatIso')
    .replace('AND effect_type IN ${sql.in(PROCESS_BOUND_EFFECT_TYPES)}',
      'AND effect_type IN ${sql.in(PROCESS_BOUND_EFFECT_TYPES)}\n            AND ${processLossDeadline(consumption)}')
    .replace('AND effect_type IN ${sql.in(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS)}',
      'AND effect_type IN ${sql.in(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS)}\n'
      + '            AND ${processLossDeadline(consumption)}')
    .replace('        if (requeuedRows.length > 0)', `        if (consumption) {
          const cancelled = consumption.prepared.rows.filter(row => processLossTransition(row) === "cancel").length;
          if (cancelledRows.length !== cancelled
            || requeuedRows.length !== consumption.prepared.rows.length - cancelled) {
            return yield* new EffectOutboxError({ operation: "process-loss-plan-changed" });
          }
          yield* checkProcessLossDeadline(consumption);
        }
        if (requeuedRows.length > 0)`)
    .replace(/,\n$/u, ';\n')
  author.replace(file, original, `      reconcileAfterProcessLoss: reconcileProcessLoss(),
      prepareProcessLoss: Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const observedAtMs = Date.now(), observedMonotonicMs = performance.now();
        const rows = yield* sql.withTransaction(readProcessLossRows).pipe(NodeSqliteClient.readOnly);
        if (Date.now() >= observedAtMs + 5000 || performance.now() >= observedMonotonicMs + 5000) {
          return yield* new EffectOutboxError({ operation: "process-loss-plan-expired" });
        }
        const candidate = Object.freeze(new ProcessLossCandidate(processLossKey));
        processLossPlans.set(candidate, { rows, observedAtMs, observedMonotonicMs, scope });
        yield* Effect.addFinalizer(() => Effect.sync(() => { processLossPlans.delete(candidate); }));
        return candidate;
      }).pipe(Effect.mapError(cause => new EffectOutboxError({ operation: "prepare-process-loss", cause }))),
      reconcilePreparedProcessLoss: ({ candidate, notAfterMs, notAfterMonotonicMs }) => Effect.suspend(() => {
        const prepared = processLossPlans.get(candidate);
        if (!prepared) return Effect.fail(new EffectOutboxError({ operation: "process-loss-plan-closed" }));
        processLossPlans.delete(candidate); // Uncertainty, expiry and refusal cannot retry this candidate.
        const consumption = { prepared, notAfterMs, notAfterMonotonicMs };
        if (!Number.isSafeInteger(notAfterMs) || !Number.isFinite(notAfterMonotonicMs)
          || notAfterMs > prepared.observedAtMs + 5000
          || notAfterMonotonicMs > prepared.observedMonotonicMs + 5000) {
          return Effect.fail(new EffectOutboxError({ operation: "process-loss-plan-expired" }));
        }
        return reconcileProcessLoss(consumption).pipe(Effect.flatMap(result =>
          Date.now() < notAfterMs && performance.now() < notAfterMonotonicMs ? Effect.succeed(result)
            : Effect.fail(new EffectOutboxError({ operation: "process-loss-plan-outcome-uncertain" }))),
        Effect.forkIn(prepared.scope), Effect.flatMap(Fiber.join));
      }),
`, 'process-loss-shared-original-transaction')
  author.replace(file, '    const service: EffectOutboxV2Shape = {', `    const digestEffectRow = (row: Readonly<EffectRow>) => "sha256:" + createHash("sha256")
      .update(JSON.stringify(["nessie.t3.pending-effect-row.v1", ...claimColumns.map(column => row[column])]), "utf8")
      .digest("hex");
    const processLossTransition = (row: Readonly<EffectRow>): "cancel" | "requeue" =>
      PROCESS_BOUND_EFFECT_TYPES.some(type => type === row.effect_type) ? "cancel" : "requeue";
    const processLossSelection = sql\`((status IN ('pending', 'running')
      AND effect_type IN \${sql.in(PROCESS_BOUND_EFFECT_TYPES)}) OR (status = 'running'
      AND effect_type IN \${sql.in(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS)}))\`;
    const readProcessLossRows = Effect.gen(function* () {
      const schema = yield* sql<{ readonly recognized: number }>\`SELECT \${claimSchemaPredicate} AS recognized\`;
      if (schema[0]?.recognized !== 1) return yield* new EffectOutboxError({ operation: "process-loss-plan-schema" });
      // Bound allocation before returning raw payload/error strings to JavaScript.
      const budget = yield* sql<{ readonly count: number; readonly bytes: number | null }>\`
        SELECT count(*) AS count, sum(length(CAST(json_array(effect_id, command_id, thread_id,
          effect_type, payload_json, status, attempt_count, available_at, lease_owner, lease_expires_at,
          created_at, updated_at, completed_at, last_error) AS BLOB))) AS bytes
        FROM orchestration_v2_effect_outbox WHERE \${processLossSelection}
      \`;
      if (!budget[0] || budget[0].count > 256 || (budget[0].bytes ?? 0) > 2 * 1024 * 1024) {
        return yield* new EffectOutboxError({ operation: "process-loss-plan-size" });
      }
      const rows = yield* sql<EffectRow>\`
        SELECT * FROM orchestration_v2_effect_outbox
        WHERE \${processLossSelection}
          AND \${claimSchemaPredicate}
        ORDER BY effect_id COLLATE BINARY ASC LIMIT 257
      \`;
      let bytes = 0;
      const nullable = new Set(["lease_owner", "lease_expires_at", "completed_at", "last_error"]);
      if (rows.length > 256) return yield* new EffectOutboxError({ operation: "process-loss-plan-size" });
      for (const row of rows) {
        if (Object.keys(row).length !== claimColumns.length || claimColumns.some(column =>
          !Object.hasOwn(row, column) || (column === "attempt_count"
            ? !Number.isSafeInteger(row[column]) || row[column] < 0
            : typeof row[column] !== "string" && !(nullable.has(column) && row[column] === null)))) {
          return yield* new EffectOutboxError({ operation: "process-loss-plan-row" });
        }
        bytes += Buffer.byteLength(JSON.stringify(claimColumns.map(column => row[column])), "utf8");
        if (bytes > 1024 * 1024) return yield* new EffectOutboxError({ operation: "process-loss-plan-size" });
      }
      return rows.map(row => Object.freeze({ ...row }));
    }).pipe(Effect.withTracerEnabled(false));
    type ProcessLossPlan = { readonly rows: ReadonlyArray<Readonly<EffectRow>>;
      readonly observedAtMs: number; readonly observedMonotonicMs: number; readonly scope: Scope.Scope };
    type ProcessLossConsumption = { readonly prepared: ProcessLossPlan } & OrchestrationEffectClaimDeadline;
    const processLossPlans = new WeakMap<OrchestrationProcessLossCandidate, ProcessLossPlan>();
    const processLossKey = Object.freeze({});
    const processLossPlan = (candidate: OrchestrationProcessLossCandidate) => {
      const plan = processLossPlans.get(candidate);
      if (!plan) throw new EffectOutboxError({ operation: "process-loss-plan-closed" });
      return plan;
    };
    class ProcessLossCandidate implements OrchestrationProcessLossCandidate {
      declare readonly [processLossCandidateBrand]: true;
      constructor(key: object) {
        if (key !== processLossKey) throw new EffectOutboxError({ operation: "process-loss-plan-closed" });
      }
      get observedAtMs(): number { return processLossPlan(this).observedAtMs; }
      get planDigest(): string {
        return "sha256:" + createHash("sha256").update(JSON.stringify(["nessie.t3.process-loss-plan.v1",
          processLossPlan(this).rows.map(row => [processLossTransition(row), digestEffectRow(row)]),
        ]), "utf8").digest("hex");
      }
      get effects(): OrchestrationProcessLossCandidate["effects"] {
        return processLossPlan(this).rows.map(row => Object.freeze({ effectId: row.effect_id,
        commandId: row.command_id, threadId: row.thread_id, effectType: row.effect_type,
        transition: processLossTransition(row), rowDigest: digestEffectRow(row) })); }
    }
    Object.freeze(ProcessLossCandidate.prototype);
    const processLossDeadline = (consumption?: ProcessLossConsumption) => consumption === undefined ? sql\`1 = 1\` : sql\`
      \${claimSchemaPredicate} AND CAST(unixepoch('subsec') * 1000 AS INTEGER) < \${consumption.notAfterMs}
      AND nessie_t3_monotonic_now() < \${consumption.notAfterMonotonicMs}
    \`;
    const checkProcessLossDeadline = (consumption: ProcessLossConsumption) => Effect.gen(function* () {
      const checked = yield* sql<{ readonly current: number }>\`SELECT \${processLossDeadline(consumption)} AS current\`;
      if (checked[0]?.current !== 1) return yield* new EffectOutboxError({ operation: "process-loss-plan-expired" });
    });
    const checkProcessLoss = (consumption: ProcessLossConsumption) => Effect.gen(function* () {
      yield* checkProcessLossDeadline(consumption);
      const rows = yield* readProcessLossRows;
      if (JSON.stringify(rows.map(row => claimColumns.map(column => row[column]))) !== JSON.stringify(
        consumption.prepared.rows.map(row => claimColumns.map(column => row[column])))) {
        return yield* new EffectOutboxError({ operation: "process-loss-plan-changed" });
      }
    });
${shared}
    const service: EffectOutboxV2Shape = {`, 'process-loss-exact-scoped-row-plan')
}
