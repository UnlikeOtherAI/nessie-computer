/** Scoped ownership of the original complete legacy-shell action. The exact
 * read/write functions come from its original constructor, never a DTO caller. */
export const legacyShellOwner = `import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ThreadId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as EventSink from "../EventSink.ts";
import { LegacyV1ThreadImportError, type LegacyV1ImportSummary } from "./LegacyV1ThreadImporter.ts";

export declare const legacyShellCandidateBrand: unique symbol;
export interface LegacyShellTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly action: "repair" | "import";
}
/** Input evidence only. Neither parsing metadata nor possessing this candidate grants authority. */
export interface LegacyShellReconciliationCandidate {
  readonly [legacyShellCandidateBrand]: true;
  readonly observedAtMs: number;
  readonly notAfterMonotonicMs: number;
  readonly planDigest: string;
  readonly targets: ReadonlyArray<LegacyShellTarget>;
}
interface Data<I> { readonly inputs: I; readonly targets: ReadonlyArray<LegacyShellTarget>; }
type Window = NodeSqliteClient.SqliteStatementDeadline;
const refused = (reason: string) => new LegacyV1ThreadImportError({ operation: "shell-plan", cause: reason });
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = (encoded: string) => "sha256:" + createHash("sha256")
  .update('["nessie.t3.legacy-shell-plan.v1",' + encoded + ']', "utf8").digest("hex");
const mapError = (cause: unknown) => cause instanceof LegacyV1ThreadImportError ? cause : refused("shell-plan-failed");
const freeze = <A>(value: A): A => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const makeLegacyShellReconciliation = <I>(sql: SqlClient.SqlClient,
  eventSink: EventSink.EventSinkV2["Service"],
  read: Effect.Effect<Data<I>, LegacyV1ThreadImportError>,
  write: (inputs: I) => Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>,
  schema: Effect.Effect<unknown, LegacyV1ThreadImportError>) => {
  interface Plan {
    readonly data: Data<I>; readonly encoded: string; readonly digest: string;
    readonly observedAtMs: number; readonly observedMonotonicMs: number; readonly scope: Scope.Scope;
  }
  const plans = new WeakMap<LegacyShellReconciliationCandidate, Plan>();
  const key = Object.freeze({});
  const get = (candidate: LegacyShellReconciliationCandidate) => {
    const plan = plans.get(candidate);
    if (!plan) throw refused("shell-plan-closed");
    return plan;
  };
  class Candidate implements LegacyShellReconciliationCandidate {
    declare readonly [legacyShellCandidateBrand]: true;
    constructor(supplied: object) { if (supplied !== key) throw refused("shell-plan-closed"); }
    get observedAtMs(): number { return get(this).observedAtMs; }
    get notAfterMonotonicMs(): number { return get(this).observedMonotonicMs + 5000; }
    get planDigest(): string { return get(this).digest; }
    get targets(): ReadonlyArray<LegacyShellTarget> { return get(this).data.targets.map(target => ({ ...target })); }
  }
  Object.freeze(Candidate.prototype);
  const withoutAmbientTransaction = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* refused("shell-plan-ambient-transaction");
    }
  });
  const prepareShellReconciliation = Effect.gen(function* () {
    yield* withoutAmbientTransaction;
    const scope = yield* Scope.Scope;
    const observedAtMs = Date.now(), observedMonotonicMs = performance.now();
    // The writer's connection-local TEMP schema is part of this action's input.
    // These are fixed SELECTs only; a pooled reader cannot observe that schema.
    const raw = yield* sql.withTransaction(read).pipe(NodeSqliteClient.withInterruptibleTransactionWait,
      Effect.interruptible, Effect.timeout(5000));
    const data = freeze(structuredClone(raw)), encoded = canonical(data);
    if (data.targets.length > 256 || Buffer.byteLength(encoded, "utf8") > 4 * 1024 * 1024
      || Date.now() >= observedAtMs + 5000 || performance.now() >= observedMonotonicMs + 5000) {
      return yield* refused("shell-plan-size-or-expiry");
    }
    const candidate = Object.freeze(new Candidate(key));
    plans.set(candidate, { data, encoded, digest: digest(encoded), scope, observedAtMs, observedMonotonicMs });
    yield* Effect.addFinalizer(() => Effect.sync(() => { plans.delete(candidate); }));
    return candidate as LegacyShellReconciliationCandidate;
  }).pipe(Effect.mapError(mapError));
  const reconcileShellsPrepared = ({ candidate, ...window }:
    { readonly candidate: LegacyShellReconciliationCandidate } & Window) => Effect.suspend(() => {
    const plan = plans.get(candidate);
    if (!plan) return Effect.fail(refused("shell-plan-closed"));
    plans.delete(candidate);
    if (!Number.isSafeInteger(window.notAfterMs) || !Number.isFinite(window.notAfterMonotonicMs)
      || window.notAfterMs > plan.observedAtMs + 5000
      || window.notAfterMonotonicMs > plan.observedMonotonicMs + 5000) {
      return Effect.fail(refused("shell-plan-expired"));
    }
    const current = Effect.suspend(() => Date.now() < window.notAfterMs
      && performance.now() < window.notAfterMonotonicMs ? Effect.void : Effect.fail(refused("shell-plan-expired")));
    const work = Effect.gen(function* () {
      yield* withoutAmbientTransaction;
      return yield* eventSink.withProviderBatch(Effect.gen(function* () {
        yield* current;
        if (canonical(yield* read) !== plan.encoded) return yield* refused("shell-plan-changed");
        const schemaBefore = canonical(yield* schema);
        const actual = yield* write(plan.data.inputs);
        if (canonical(yield* schema) !== schemaBefore) return yield* refused("shell-plan-schema-changed");
        yield* current;
        return actual;
      }));
    }).pipe(NodeSqliteClient.withStatementDeadline(window), NodeSqliteClient.withInterruptibleTransactionWait,
      Effect.flatMap(result => current.pipe(Effect.as(result))), Effect.mapError(mapError));
    const remaining = Math.max(0, Math.min(window.notAfterMs - Date.now(), window.notAfterMonotonicMs - performance.now()));
    return work.pipe(Effect.timeout(remaining), Effect.mapError(mapError), Effect.forkIn(plan.scope), Effect.flatMap(Fiber.join));
  });
  return { prepareShellReconciliation, reconcileShellsPrepared };
};
`;
