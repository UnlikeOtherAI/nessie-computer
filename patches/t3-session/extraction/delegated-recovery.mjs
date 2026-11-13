import { selectedImports } from './author.mjs'

/** One original recovery implementation; retained failures are lifecycle facts,
 * never a successful startup or permission to perform the enclosed writes. */
export const extractDelegatedRecovery = (author, redirects) => {
  const file = 'apps/server/src/orchestration-v2/Orchestrator.ts'
  const api = file.replace('.ts', '.session-api.ts')
  const target = 'apps/server/src/orchestration-v2/DelegatedTaskRecovery.ts'
  for (const [message, indent, fields] of [
    ['Failed to recover terminal app-owned subagent', 14, ['childThreadId: threadId', 'cause']],
    ['Failed to inspect app-owned subagents during recovery', 6, ['cause']],
    ['Failed to recover delegated completion delivery', 16, ['threadId', 'cause']],
    ['Failed to inspect delegated completion delivery during recovery', 6, ['cause']],
  ]) {
    const pad = ' '.repeat(indent)
    const warning = `${pad}Effect.catchCause((cause) =>\n`
      + `${pad}  Effect.logWarning("${message}", {\n`
      + fields.map(field => `${pad}    ${field},\n`).join('')
      + `${pad}  }),\n${pad}),\n`
    author.replace(file, warning, '', `delegated-recovery-retain:${message}`)
  }
  // The recovery call reaches this original helper too. An unsuccessful
  // dismissal cannot disappear inside the otherwise strict outer operation.
  author.replace(file, `          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to dismiss task question", {
              requestId: request.id,
              cause,
            }),
          ),
`, '', 'delegated-recovery-retain-question-dismissal')
  for (const [from, to, name] of [
    ['            }).pipe(\n            ),', '            }),', 'child'],
    ['              )\n              .pipe(\n              ),', '              ),', 'delivery'],
    ['        }).pipe(\n        );', '        });', 'question'],
  ]) author.replace(file, from, to, `delegated-recovery-remove-empty-pipe:${name}`)
  author.replace(file, `    (effect, threadId, _sourceRunId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to recover delegated task after restart", {
            childThreadId: threadId,
            cause,
          }),
        ),
      ),`, `    (effect, _threadId, _sourceRunId) => retainRecoveryFailure(effect),`,
  'delegated-recovery-retain-single-restart-failure')

  const terminal = author.between(file, 'function delegatedTaskTerminalStatus(',
    '/** Failed worktree setup keeps the queue held')
  const operation = author.between(file, '  const recoverDelegatedTasks = Effect.gen(function* () {',
    '  const delegatedTaskResultPending =')
  const types = `export class DelegatedTaskRecoveryError extends Schema.TaggedError<DelegatedTaskRecoveryError>()(
  "DelegatedTaskRecoveryError", { cause: Schema.Defect() },
) {}

export const retainRecoveryFailure = <A, E, R>(effect: Effect.Effect<A, E, R>):
  Effect.Effect<A, DelegatedTaskRecoveryError, R> => effect.pipe(
    Effect.mapError(cause => new DelegatedTaskRecoveryError({ cause })));

interface Inputs<E, R> {
  readonly projectionStore: Pick<ProjectionStoreV2["Service"],
    "getRecoveryThreadIds" | "getThreadShell" | "getThreadRecords">;
  readonly threadDispatch: ThreadCommandExecutor.ThreadCommandExecutor["Service"];
  readonly finalizeAppOwnedSubagent: (threadId: ThreadId) => Effect.Effect<void, E, R>;
  readonly finalizeDelegatedCompletionDelivery: (threadId: ThreadId, runId: RunId) => Effect.Effect<void, E, R>;
  readonly offerDelegatedCompletionDelivery: (threadId: ThreadId, runId: RunId) => Effect.Effect<void, E, R>;
}

/** Required real services and private original callbacks; no fallback,
 * provider construction or recovery permission is supplied here. */
export const make = <E, R>(input: Inputs<E, R>): Effect.Effect<void, DelegatedTaskRecoveryError, R> => {
  const { projectionStore, threadDispatch, finalizeAppOwnedSubagent,
    finalizeDelegatedCompletionDelivery, offerDelegatedCompletionDelivery } = input;
`
  author.derive(target, [selectedImports(author.read(file), terminal + operation + ' Schema ThreadId RunId',
    file, target, redirects),
    'import type { ProjectionStoreV2 } from "./ProjectionStore.ts";\n'
      + 'import type * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";\n',
    author.sourcePart(file, terminal, { current: true }),
    'export { delegatedTaskTerminalStatus };\n\n', types,
    author.sourcePart(file, operation, { current: true }),
    `  return retainRecoveryFailure(recoverDelegatedTasks);
};
`], 'delegated-recovery-shared-original-operation')
  author.replace(file, terminal, '', 'delegated-recovery-share-terminal-status')
  author.replace(file, operation, `  const recoverDelegatedTasks = makeDelegatedTaskRecovery({
    projectionStore, threadDispatch, finalizeAppOwnedSubagent,
    finalizeDelegatedCompletionDelivery, offerDelegatedCompletionDelivery,
  });

`, 'delegated-recovery-use-shared-original-operation')
  const first = author.read(file).match(/^import[\s\S]*?;/u)[0]
  author.replace(file, first, `import { make as makeDelegatedTaskRecovery, delegatedTaskTerminalStatus, retainRecoveryFailure }
  from "./DelegatedTaskRecovery.ts";
${first}`, 'delegated-recovery-import-shared-operation')
  const apiFirst = author.read(api).match(/^import[\s\S]*?;/u)[0]
  author.replace(api, apiFirst, `import type { DelegatedTaskRecoveryError } from "./DelegatedTaskRecovery.ts";
${apiFirst}`, 'delegated-recovery-named-error-contract')
  author.replace(api, '  readonly recoverDelegatedTasks: Effect.Effect<void>;',
    '  readonly recoverDelegatedTasks: Effect.Effect<void, DelegatedTaskRecoveryError>;',
    'delegated-recovery-error-result')
  author.replace(api,
    '  readonly recoverDelegatedTask: (threadId: ThreadId, sourceRunId: RunId) => Effect.Effect<void>;',
    '  readonly recoverDelegatedTask: (threadId: ThreadId, sourceRunId: RunId) => Effect.Effect<void, DelegatedTaskRecoveryError>;',
    'delegated-recovery-single-error-result')
}
