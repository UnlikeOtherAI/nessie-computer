/** Capture the original child command at creation. This observation is not an
 * admission, receipt or replacement for the original run-event command ID. */
export const extractCommandLineage = author => {
  const file = 'apps/server/src/orchestration-v2/ThreadLaunchService.ts'
  const target = 'apps/server/src/orchestration-v2/SessionCommandLineage.ts'
  author.add(target, `import type { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface InitialMessageCommandEdge {
  readonly parentCommandId: CommandId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}
export class SessionCommandLineageError extends Error {
  constructor() { super("T3_SESSION_COMMAND_LINEAGE_REFUSED"); this.name = "SessionCommandLineageError"; }
}
/** Required only by the protected session variant. Observing an edge grants no effects. */
export class SessionCommandLineage extends Context.Service<SessionCommandLineage, {
  readonly recordInitialMessage: (edge: InitialMessageCommandEdge) => Effect.Effect<void, SessionCommandLineageError>;
}>()("nessie/session-engine/SessionCommandLineage") {}
`, 'original-command-lineage-port')
  const first = author.read(file).match(/^import[^;]+;/u)[0]
  author.replace(file, first, `import { SessionCommandLineage } from "./SessionCommandLineage.ts";\n${first}`,
    'original-command-lineage-import')
  author.replace(file, 'const make = Effect.gen(function* () {',
    'const makeWithCommandLineage = (lineage?: SessionCommandLineage["Service"]) => Effect.gen(function* () {',
    'original-command-lineage-construction')
  const dispatch = `          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",`
  author.replace(file, dispatch, `          if (lineage !== undefined) {
            yield* lineage.recordInitialMessage({
              parentCommandId: input.commandId, commandId: messageCommandId, threadId, messageId,
            }).pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          }
${dispatch}`, 'original-command-lineage-before-dispatch')
  author.replace(file, 'export const layer = Layer.effect(ThreadLaunchService, make);',
    `export const layer = Layer.effect(ThreadLaunchService, makeWithCommandLineage());
/** Same original constructor, with a real scoped lineage owner required. */
export const sessionLayer = Layer.effect(ThreadLaunchService, Effect.gen(function* () {
  return yield* makeWithCommandLineage(yield* SessionCommandLineage);
}));`, 'original-command-lineage-required-session-layer')
}
