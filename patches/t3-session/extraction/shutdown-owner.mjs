/** Scoped ownership of the whole original shutdown preparation. This remains
 * a conditional SQL consumer, not a positive lifecycle authority producer. */
export const shutdownPreparationOwner = `
  const projectionFields = ProjectionCodec.fields;
  const encodeProjection = Schema.encodeSync(Schema.Struct({
    thread: projectionFields.thread, runs: projectionFields.runs, attempts: projectionFields.attempts,
    nodes: projectionFields.nodes, subagents: projectionFields.subagents,
    providerSessions: projectionFields.providerSessions, providerThreads: projectionFields.providerThreads,
    providerTurns: projectionFields.providerTurns, runtimeRequests: projectionFields.runtimeRequests,
    messages: projectionFields.messages, turnItems: projectionFields.turnItems,
  }));
  const encodeSettings = Schema.encodeSync(ServerSettingsCodec);
  const decodeSettings = Schema.decodeSync(ServerSettingsCodec);
  const digest = (domain: string, value: unknown) => "sha256:" + createHash("sha256")
    .update(JSON.stringify([domain, value]), "utf8").digest("hex");
  const refused = (reason: string) => new ProviderRuntimeRecoveryError({
    operation: "shutdown-plan", cause: reason });
  const withoutAmbientTransaction = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* refused("shutdown-plan-ambient-transaction");
    }
  });
  const readPlan = Effect.gen(function* () {
    const value = yield* settings.getSettings.pipe(Effect.mapError(cause =>
      new ProviderRuntimeRecoveryError({ operation: "read-settings", cause })));
    // The original codecs copy settings before any further async read. Neither
    // their bytes nor projection payloads are exposed by the candidate.
    const encodedSettings = encodeSettings(value);
    const selectedSettings = decodeSettings(encodedSettings);
    const threadIds = yield* readThreadIds(selectedSettings);
    if (threadIds.length > 256 || new Set(threadIds).size !== threadIds.length) {
      return yield* refused("shutdown-plan-size");
    }
    const inputs: Array<readonly [string, unknown]> = [];
    const effects: Array<ContinuationEffect> = [];
    let bytes = Buffer.byteLength(JSON.stringify(encodedSettings), "utf8");
    if (bytes > 4 * 1024 * 1024) return yield* refused("shutdown-plan-size");
    // One readonly transaction supplies every original projection. The normal
    // unprepared operation retains its original concurrent read/write policy.
    for (const threadId of threadIds) {
      const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
      if (projection.thread.id !== threadId) return yield* refused("shutdown-plan-thread-mismatch");
      const now = yield* DateTime.now;
      const encoded = encodeProjection(projection);
      bytes += Buffer.byteLength(JSON.stringify(encoded), "utf8");
      if (bytes > 4 * 1024 * 1024) return yield* refused("shutdown-plan-size");
      inputs.push([threadId, encoded]);
      const effect = selectContinuation(selectedSettings, projection, now, threadId);
      if (effect) effects.push(Object.freeze({ ...effect, request: Object.freeze({ ...effect.request }) }));
    }
    const slots = yield* outbox.inspectRestartContinuationSlots(effects);
    const inputDigest = digest("nessie.t3.shutdown-inputs.v1", [encodedSettings, inputs]);
    const settingsDigest = digest("nessie.t3.shutdown-settings.v1", encodedSettings);
    const planDigest = digest("nessie.t3.shutdown-plan.v1", [inputDigest, effects, slots]);
    return { inputDigest, settingsDigest, planDigest, threadIds, effects, slots };
  }).pipe(Effect.withTracerEnabled(false));
  type Plan = Effect.Success<typeof readPlan> & { readonly scope: Scope.Scope;
    readonly observedAtMs: number; readonly observedMonotonicMs: number };
  const plans = new WeakMap<ShutdownPreparationCandidate, Plan>();
  const key = Object.freeze({});
  const get = (candidate: ShutdownPreparationCandidate) => {
    const plan = plans.get(candidate);
    if (!plan) throw refused("shutdown-plan-closed");
    return plan;
  };
  class Candidate implements ShutdownPreparationCandidate {
    declare readonly [shutdownPreparationCandidateBrand]: true;
    constructor(supplied: object) { if (supplied !== key) throw refused("shutdown-plan-closed"); }
    get observedAtMs(): number { return get(this).observedAtMs; }
    get inputDigest(): string { return get(this).inputDigest; }
    get settingsDigest(): string { return get(this).settingsDigest; }
    get planDigest(): string { return get(this).planDigest; }
    get threadIds(): ReadonlyArray<ThreadId> { return [...get(this).threadIds]; }
    get effects(): ShutdownPreparationCandidate["effects"] {
      const plan = get(this);
      return plan.effects.map((effect, index) => Object.freeze({ effectId: effect.id,
        commandId: effect.commandId, threadId: effect.threadId,
        sourceRunId: effect.request.sourceRunId,
        existingRowDigest: plan.slots[index]!.rowDigest }));
    }
  }
  Object.freeze(Candidate.prototype);
  const mapError = (cause: unknown) => isProviderRuntimeRecoveryError(cause) ? cause
    : new ProviderRuntimeRecoveryError({ operation: "shutdown-plan", cause });
  const prepareShutdownPlan = Effect.gen(function* () {
    yield* withoutAmbientTransaction;
    const scope = yield* Scope.Scope;
    const observedAtMs = Date.now(), observedMonotonicMs = performance.now();
    // Shutdown finalizers are masked. This readonly observation still needs a
    // finite wait; it cannot strand cleanup before an owner even sees a plan.
    const plan = yield* sql.withTransaction(readPlan).pipe(NodeSqliteClient.readOnly,
      Effect.interruptible, Effect.timeout(5000));
    if (Date.now() >= observedAtMs + 5000 || performance.now() >= observedMonotonicMs + 5000) {
      return yield* refused("shutdown-plan-expired");
    }
    const candidate = Object.freeze(new Candidate(key));
    plans.set(candidate, { ...plan, scope, observedAtMs, observedMonotonicMs });
    yield* Effect.addFinalizer(() => Effect.sync(() => { plans.delete(candidate); }));
    return candidate;
  }).pipe(Effect.mapError(mapError));
  const prepareForShutdownPrepared = (input: { readonly candidate: ShutdownPreparationCandidate }
    & EffectOutbox.OrchestrationEffectClaimDeadline) => Effect.suspend(() => {
      const plan = plans.get(input.candidate);
      if (!plan) return Effect.fail(refused("shutdown-plan-closed"));
      plans.delete(input.candidate); // Burn before SQL, including uncertainty and refusal.
      const { notAfterMs, notAfterMonotonicMs } = input;
      if (!Number.isSafeInteger(notAfterMs) || !Number.isFinite(notAfterMonotonicMs)
        || notAfterMs > plan.observedAtMs + 5000 || notAfterMonotonicMs > plan.observedMonotonicMs + 5000) {
        return Effect.fail(refused("shutdown-plan-expired"));
      }
      const deadline = Effect.gen(function* () {
        const rows = yield* sql<{ readonly current: number }>\`SELECT
          CAST(unixepoch('subsec') * 1000 AS INTEGER) < \${notAfterMs}
          AND nessie_t3_monotonic_now() < \${notAfterMonotonicMs} AS current\`;
        if (rows[0]?.current !== 1) return yield* refused("shutdown-plan-expired");
      });
      const work = Effect.gen(function* () {
        yield* withoutAmbientTransaction;
        return yield* eventSink.withProviderBatch(Effect.gen(function* () {
          yield* deadline;
          const current = yield* readPlan;
          if (current.planDigest !== plan.planDigest) return yield* refused("shutdown-plan-changed");
          yield* Effect.forEach(plan.effects, effect => deadline.pipe(Effect.andThen(writeContinuation(effect))),
            { concurrency: 2, discard: true });
          const after = yield* readPlan;
          if (after.inputDigest !== plan.inputDigest || JSON.stringify(after.effects) !== JSON.stringify(plan.effects)
            || after.slots.some((slot, index) => slot.rowDigest === null
              || (plan.slots[index]!.rowDigest !== null && slot.rowDigest !== plan.slots[index]!.rowDigest))) {
            return yield* refused("shutdown-plan-changed");
          }
          yield* deadline;
        }).pipe(Effect.provideService(EffectOutbox.RestartContinuationWriteFence,
          { notAfterMs, notAfterMonotonicMs, effectIds: Object.freeze(plan.effects.map(effect => effect.id)) })));
      }).pipe(Effect.flatMap(() => Date.now() < notAfterMs && performance.now() < notAfterMonotonicMs
        ? Effect.void : Effect.fail(refused("shutdown-plan-outcome-uncertain"))), Effect.mapError(mapError));
      const remaining = Math.max(0, Math.min(notAfterMs - Date.now(), notAfterMonotonicMs - performance.now()));
      return work.pipe(NodeSqliteClient.withInterruptibleTransactionWait, Effect.timeout(remaining),
        Effect.mapError(mapError), Effect.forkIn(plan.scope), Effect.flatMap(Fiber.join));
    });
`;
