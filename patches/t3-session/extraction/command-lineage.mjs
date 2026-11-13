/** Capture the original child command at creation. This observation is not an
 * admission, receipt or replacement for the original run-event command ID. */
export const extractCommandLineage = author => {
  const file = 'apps/server/src/orchestration-v2/ThreadLaunchService.ts'
  const target = 'apps/server/src/orchestration-v2/SessionCommandLineage.ts'
  author.add(target, `import type { CommandId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface InitialMessageCommandEdge {
  readonly parentCommandId: CommandId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}
export interface InitialMessageRunEdge extends InitialMessageCommandEdge {
  readonly runId: RunId;
}
export interface PreparedRunReleaseCommandEdge {
  readonly parentCommandId: CommandId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}
export class SessionCommandLineageError extends Error {
  constructor() { super("T3_SESSION_COMMAND_LINEAGE_REFUSED"); this.name = "SessionCommandLineageError"; }
}
/** Required only by the protected session variant. Observing an edge grants no effects. */
export class SessionCommandLineage extends Context.Service<SessionCommandLineage, {
  readonly recordInitialMessage: (edge: InitialMessageCommandEdge) => Effect.Effect<void, SessionCommandLineageError>;
  readonly recordInitialMessageRun: (edge: InitialMessageRunEdge) => Effect.Effect<void, SessionCommandLineageError>;
  readonly recordPreparedRunRelease: (edge: PreparedRunReleaseCommandEdge) => Effect.Effect<void, SessionCommandLineageError>;
  readonly recordPreparedRunReleased: (edge: PreparedRunReleaseCommandEdge) => Effect.Effect<void, SessionCommandLineageError>;
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
  const accepted = `            )("Initial message was accepted without a durable run.");
          }`
  author.replace(file, accepted, `${accepted}
          if (lineage !== undefined) {
            yield* lineage.recordInitialMessageRun({
              parentCommandId: input.commandId, commandId: messageCommandId, threadId, messageId, runId,
            }).pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          }`, 'original-command-lineage-accepted-run')
  const release = `      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(\`\${input.commandId}:release\`),`
  author.replace(file, release, `      if (runId !== null) {
        const releaseCommandId = CommandId.make(\`\${input.commandId}:release\`);
        if (lineage !== undefined) {
          yield* lineage.recordPreparedRunRelease({
            parentCommandId: input.commandId, commandId: releaseCommandId, threadId, runId,
          }).pipe(Effect.mapError(mapError(input, "release-run", threadId)));
        }
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: releaseCommandId,`, 'original-command-lineage-before-prepared-release')
  const released = `            Effect.uninterruptible,
          );
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");`
  author.replace(file, released, `            Effect.uninterruptible,
          );
        if (lineage !== undefined) {
          yield* lineage.recordPreparedRunReleased({
            parentCommandId: input.commandId, commandId: releaseCommandId, threadId, runId,
          }).pipe(Effect.mapError(mapError(input, "release-run", threadId)));
        }
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");`, 'original-command-lineage-accepted-release')
  author.replace(file, 'export const layer = Layer.effect(ThreadLaunchService, make);',
    `export const layer = Layer.effect(ThreadLaunchService, makeWithCommandLineage());
/** Same original constructor, with a real scoped lineage owner required. */
export const sessionLayer = Layer.effect(ThreadLaunchService, Effect.gen(function* () {
  return yield* makeWithCommandLineage(yield* SessionCommandLineage);
}));`, 'original-command-lineage-required-session-layer')
}
