/** Protect the original worker's claim point, without replacing its execution,
 * cancellation or settlement implementation. Ordinary upstream composition stays separate. */
export const extractWorkerClaims = author => {
  const directory = 'apps/server/src/orchestration-v2/'
  author.add(`${directory}SessionEffectClaimAuthority.ts`, `import type { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { EffectOutboxError, OrchestrationEffectClaimCandidate, OrchestrationEffectV2,
  OrchestrationEffectClaimDeadline } from "./EffectOutbox.ts";

export class SessionEffectClaimRefused extends Error {
  constructor() { super("T3_SESSION_EFFECT_CLAIM_REFUSED"); this.name = "SessionEffectClaimRefused"; }
}
/** REQUIRED current original-admission/native owner. Command IDs are routing
 * only. The owner must independently admit the exact candidate before invoking
 * claim once with the original finite absolute expiry, preserving its result.
 * No production producer, blanket recovery grant or metadata promotion exists here. */
export class SessionEffectClaimAuthority extends Context.Service<SessionEffectClaimAuthority, {
  readonly commands: Effect.Effect<ReadonlyArray<CommandId>, SessionEffectClaimRefused>;
  readonly awaitChanged: Effect.Effect<void>;
  readonly withClaim: (candidate: OrchestrationEffectClaimCandidate,
    claim: (deadline: OrchestrationEffectClaimDeadline) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>) =>
    Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError | SessionEffectClaimRefused>;
}>()("nessie/session-engine/SessionEffectClaimAuthority") {}
`, 'protected-worker-current-claim-owner')
  const file = `${directory}EffectWorker.ts`
  const first = author.read(file).match(/^import[^;]+;/u)[0]
  author.replace(file, first,
    `import { SessionEffectClaimAuthority, SessionEffectClaimRefused } from "./SessionEffectClaimAuthority.ts";\n${first}`,
    'protected-worker-claim-owner-import')
  author.replace(file, `export const layerWithOptions = (
  options: OrchestrationEffectWorkerOptions = {},
): Layer.Layer<`, `const makeWorkerLayer = (
  options: OrchestrationEffectWorkerOptions = {},
  admission?: SessionEffectClaimAuthority["Service"],
): Layer.Layer<`, 'protected-worker-shared-original-constructor')
  const seam = '      // The worker probes for work repeatedly, including when the outbox is empty.'
  author.replace(file, seam, `      const claimNext = (excludeRestartContinuations: boolean) => {
        if (admission === undefined) return outbox.claimNext({ workerId, excludeRestartContinuations });
        return Effect.scoped(Effect.gen(function* () {
          const commandIds = yield* admission.commands;
          const prepared = yield* outbox.prepareClaim({ workerId, commandIds, excludeRestartContinuations });
          if (Option.isNone(prepared)) return Option.none();
          let called = false;
          let actual: Option.Option<EffectOutbox.OrchestrationEffectV2> | undefined;
          const admitted = yield* admission.withClaim(prepared.value, (deadline) => Effect.gen(function* () {
            if (called) return yield* new EffectOutbox.EffectOutboxError({ operation: "claim-candidate-replayed" });
            called = true;
            actual = yield* outbox.claimPrepared({ candidate: prepared.value, ...deadline });
            return actual;
          }));
          // A required host cannot substitute a fabricated success or a different
          // query result for the actual original conditional transition.
          if ((!called && Option.isSome(admitted)) || (called && admitted !== actual)) {
            return yield* Effect.fail(new SessionEffectClaimRefused());
          }
          return admitted;
        }));
      };

${seam}`, 'protected-worker-admit-before-original-claim')
  author.replace(file, '            outbox.claimNext({ workerId, excludeRestartContinuations }),',
    '            claimNext(excludeRestartContinuations),', 'protected-worker-use-admitted-claim')
  author.replace(file, '        awaitWork: outbox.awaitAvailable,',
    '        awaitWork: admission === undefined ? outbox.awaitAvailable\n'
      + '          : Effect.raceFirst(outbox.awaitAvailable, admission.awaitChanged),', 'protected-worker-admission-wakeup')
  author.replace(file, '        nextClaimableAt: outbox.nextClaimableAt.pipe(',
    `        nextClaimableAt: (admission === undefined ? outbox.nextClaimableAt
          : admission.commands.pipe(Effect.flatMap(outbox.nextClaimableAtForCommands))).pipe(`,
    'protected-worker-scope-next-deadline')
  author.replace(file, 'export const layer = layerWithOptions();',
    `export const layerWithOptions = (options: OrchestrationEffectWorkerOptions = {}) => makeWorkerLayer(options);
export const layer = layerWithOptions();
/** No default admission owner; source metadata and a reserve receipt cannot supply it. */
export const sessionLayerWithOptions = (options: OrchestrationEffectWorkerOptions = {}) =>
  Layer.unwrap(Effect.map(SessionEffectClaimAuthority, (admission) => makeWorkerLayer(options, admission)));
export const sessionLayer = sessionLayerWithOptions();`, 'protected-worker-required-session-layer')
}
