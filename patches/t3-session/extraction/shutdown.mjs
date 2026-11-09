import { exportedNames, selectedImports } from './author.mjs'
import { shutdownPreparationOwner } from './shutdown-owner.mjs'

/** Split the existing original action before reusing its exact selection and
 * effect construction in a readonly plan and conditional whole transaction. */
export const extractShutdownPreparation = (author, redirects, exports) => {
  const sqlite = 'packages/shared/src/nodeSqliteClient.ts'
  author.replace(sqlite, 'const TransactionAcquire = Context.Reference<', `const InterruptibleTransactionWait = Context.Reference<boolean>(
  "nessie/session-engine/InterruptibleTransactionWait", { defaultValue: () => false });
/** Constrain acquisition only, even inside a publication owner's mask. Commit,
 * rollback and lock-finalizer installation keep their original masking. */
export const withInterruptibleTransactionWait = Effect.provideService(InterruptibleTransactionWait, true);

const TransactionAcquire = Context.Reference<`, 'shutdown-interruptible-writer-wait-owner')
  author.replace(sqlite, '          ownerAtWaitStart: undefined,\n          restore,',
    '          ownerAtWaitStart: undefined,\n          restore: Context.get(Fiber.getCurrent()!.context,\n'
    + '            InterruptibleTransactionWait) ? Effect.interruptible : restore,',
    'shutdown-retain-interruptible-acquisition-through-publication-mask')
  const file = 'apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts'
  const api = file.replace('.ts', '.session-api.ts')
  const target = 'apps/server/src/orchestration-v2/ShutdownPreparation.ts'
  const original = author.read(file)
  const declarations = author.between(file, 'export class ProviderRuntimeRecoveryError extends', 'function nonterminalRuns(')
  author.derive(api, [selectedImports(original, declarations, file, api, redirects),
    author.sourcePart(file, declarations, { current: true })], 'shutdown-share-recovery-api')
  author.replace(api, 'const isProviderRuntimeRecoveryError =', 'export const isProviderRuntimeRecoveryError =',
    'shutdown-share-recovery-error-guard')
  author.replace(api, 'Schema.Literals(["read-settings", "read-projections", "reconcile", "drain-outbox"])',
    'Schema.Literals(["read-settings", "read-projections", "reconcile", "drain-outbox", "shutdown-plan"])',
    'shutdown-recovery-plan-error-stage')
  author.replace(api, 'export class ProviderRuntimeRecoveryService extends', `export declare const shutdownPreparationCandidateBrand: unique symbol;
/** Scoped original inputs only; no native, backend or lifecycle permission. */
export interface ShutdownPreparationCandidate {
  readonly [shutdownPreparationCandidateBrand]: true;
  readonly observedAtMs: number;
  readonly settingsDigest: string;
  readonly inputDigest: string;
  readonly planDigest: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly effects: ReadonlyArray<{ readonly effectId: string; readonly commandId: CommandId;
    readonly threadId: ThreadId; readonly sourceRunId: string; readonly existingRowDigest: string | null }>;
}

export class ProviderRuntimeRecoveryService extends`, 'shutdown-scoped-plan-contract')
  author.replace(api, '    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;',
    `    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    readonly prepareShutdownPlan: Effect.Effect<ShutdownPreparationCandidate, ProviderRuntimeRecoveryError, Scope.Scope>;
    readonly prepareForShutdownPrepared: (input: { readonly candidate: ShutdownPreparationCandidate }
      & EffectOutbox.OrchestrationEffectClaimDeadline) => Effect.Effect<void, ProviderRuntimeRecoveryError>;`,
    'shutdown-plan-service-operations')
  const apiImport = author.read(api).match(/^import[^;]+;/u)[0]
  author.replace(api, apiImport, `import type { CommandId } from "@t3tools/contracts";
import type * as Scope from "effect/Scope";
import type * as EffectOutbox from "./EffectOutbox.ts";
${apiImport}`, 'shutdown-plan-service-imports')
  const names = exportedNames(declarations)
  const values = new Set(['ProviderRuntimeRecoveryError', 'ProviderRuntimeRecoveryService'])
  const imports = names.map(name => `${values.has(name) ? '' : 'type '}${name}`).join(', ')
  author.replace(file, declarations, `import { ${imports}, isProviderRuntimeRecoveryError } from "./${api.split('/').at(-1)}";
export { ${imports} };
export type { ShutdownPreparationCandidate } from "./${api.split('/').at(-1)}";

`, 'shutdown-reuse-original-recovery-identities')
  redirects.set(file, api)
  exports.set(file, new Set([...names, 'ShutdownPreparationCandidate']))
  const body = author.between(file, '  const prepareForShutdown = Effect.gen(function* () {', '  const recover =')
  const requirements = `  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const sql = yield* SqlClient.SqlClient;
`
  author.derive(target, [selectedImports(original, body + requirements, file, target, redirects),
    `import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ServerSettings as ServerSettingsCodec, OrchestrationV2ThreadProjection as ProjectionCodec }
  from "@t3tools/contracts";
import type { ServerSettings as SettingsValue, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProviderRuntimeRecoveryError, isProviderRuntimeRecoveryError } from "./${api.split('/').at(-1)}";
import type { ProviderRuntimeRecoveryService, ShutdownPreparationCandidate,
  shutdownPreparationCandidateBrand } from "./${api.split('/').at(-1)}";

type ContinuationEffect = Omit<EffectOutbox.PendingOrchestrationEffectV2, "request"> & {
  readonly request: Extract<EffectOutbox.OrchestrationEffectRequestV2, { readonly type: "provider-runtime.continue" }> };
export const make = Effect.gen(function* () {
${requirements}`,
    author.sourcePart(file, body, { current: true }),
    shutdownPreparationOwner,
    `  const service: Pick<ProviderRuntimeRecoveryService["Service"],
    "prepareForShutdown" | "prepareShutdownPlan" | "prepareForShutdownPrepared"> = {
    prepareForShutdown, prepareShutdownPlan, prepareForShutdownPrepared };
  return service;
});
`], 'shutdown-original-action-and-scoped-owner')
  const selection = author.between(target, '    const enabledProjects =', '    yield* Effect.forEach(\n      threadIds,')
  const readThreads = selection.replace('const threadIds = yield*', 'return yield*')
    .replace('enabledProjects.length === 0) return;', 'enabledProjects.length === 0) return [];')
  author.replace(target, selection, '    const threadIds = yield* readThreadIds(enabled);\n',
    'shutdown-share-original-project-selection')
  const condition = author.between(target, '          if (\n            !resolveProjectSettings',
    '          yield* eventSink.writeWithEffects({')
  const write = author.between(target, '          yield* eventSink.writeWithEffects({',
    '        }).pipe(\n          Effect.mapError((cause)')
  const effectStart = write.indexOf('              {')
  const effectEnd = write.indexOf('\n            ],', effectStart)
  const effect = write.slice(effectStart, effectEnd).trim().replace(/,$/u, '')
  const pureCondition = condition.replace('yield* DateTime.now', 'now')
  author.replace(target, condition + write, `          const effect = selectContinuation(enabled, projection, yield* DateTime.now, threadId);
          if (effect) yield* writeContinuation(effect);
`, 'shutdown-share-original-continuation-planner')
  const prefix = `  const readThreadIds = (enabled: SettingsValue) => Effect.gen(function* () {
${readThreads}  });
  const selectContinuation = (enabled: SettingsValue,
    projection: ProjectionStore.ProjectionRuntimeRecoveryState, now: DateTime.Utc,
    threadId: ThreadId): ContinuationEffect | undefined => {
${pureCondition}    return ${effect};
  };
  const writeContinuation = (effect: ContinuationEffect) => eventSink.writeWithEffects({
    commandId: effect.commandId, events: [], effects: [effect] });
`
  author.replace(target, '  const prepareForShutdown =', prefix + '  const prepareForShutdown =',
    'shutdown-original-plan-shared-helpers')
  author.replace(file, body, `  const { prepareForShutdown, prepareShutdownPlan, prepareForShutdownPrepared } = yield* makeShutdownPreparation;

`, 'shutdown-original-recovery-consumes-shared-action')
  author.replace(file, '  return ProviderRuntimeRecoveryService.of({ reconcile, prepareForShutdown, recover });',
    '  return ProviderRuntimeRecoveryService.of({ reconcile, prepareForShutdown, prepareShutdownPlan,\n'
    + '    prepareForShutdownPrepared, recover });', 'shutdown-recovery-exposes-whole-plan')
  const first = author.read(file).match(/^import[^;]+;/u)[0]
  author.replace(file, first, `import { make as makeShutdownPreparation } from "./ShutdownPreparation.ts";\n${first}`,
    'shutdown-original-recovery-import')
}
