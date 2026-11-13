/** Preserve the durable outbox command at the original executor invocation.
 * Fiber-local creation metadata is neither admission nor a claim filter. */
export const extractEffectCommand = author => {
  const directory = 'apps/server/src/orchestration-v2/'
  author.add(`${directory}OriginalEffectCommandContext.ts`, `import type { CommandId, ThreadId, RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { OrchestrationEffectV2 } from "./EffectOutbox.ts";

export interface OriginalEffectCommand {
  readonly effectId: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly effectType: OrchestrationEffectV2["request"]["type"];
  readonly runId?: RunId;
}

/** Original outbox invocation metadata only. Absent outside an executor call;
 * presence does not authorize a claim, provider, recovery or serialized frame. */
export class OriginalEffectCommandContext extends Context.Reference<OriginalEffectCommand | undefined>(
  "nessie/session-engine/OriginalEffectCommandContext", { defaultValue: () => undefined },
) {}
`, 'original-effect-command-context')
  const file = `${directory}EffectWorker.ts`
  const first = author.read(file).match(/^import[^;]+;/u)[0]
  author.replace(file, first, `import { OriginalEffectCommandContext } from "./OriginalEffectCommandContext.ts";\n${first}`,
    'original-effect-command-import')
  const end = `        }
      }),
    });
  }),
);

// A running effect blocks later work`
  author.replace(file, end, `        }
      }, (execution, effect) => execution.pipe(Effect.provideService(OriginalEffectCommandContext,
        Object.freeze({ effectId: effect.id, commandId: effect.commandId,
          threadId: effect.threadId, effectType: effect.request.type,
          ...(effect.request.type === "provider-turn.start" ? { runId: effect.request.runId } : {}) })))),
    });
  }),
);

// A running effect blocks later work`, 'original-effect-command-per-invocation')
}
