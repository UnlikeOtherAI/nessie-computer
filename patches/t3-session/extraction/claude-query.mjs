import { selectedImports, exportedNames } from './author.mjs'

/** Share the actual original queue, query controls and diagnostic stream before
 * protected reuse. The application retains its real launcher and logger. */
export const extractClaudeQuery = (author, redirects) => {
  const file = 'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts'
  const port = file.replace('.ts', '.session-port.ts')
  const protocol = file.replace('.ts', '.session-protocol.ts')
  const session = file.replace('.ts', '.session-query.ts')
  const original = author.read(file)
  const controlHelper = author.between(file, '// SDK 0.3.316 types `mcp_call`', 'const ClaudePermissionRules =')
  const turnStart = author.between(file, 'function isClaudeTurnStartMessage(', 'function isClaudeRootTurnFrame(')
  const refusal = author.between(file, 'export class ClaudeCodeRootRefusalError',
    'class ClaudeMcpRegistrationTimeoutError')
  const mcpError = author.between(file, 'class ClaudeMcpRegistrationTimeoutError',
    'export class ClaudeBackgroundWorkBlocksQueryReplacementError')
  const configuration = author.between(file, '                    if (mcpServers !== undefined) {',
    '                  }),\n                ).pipe(\n                  Effect.onError')
  const importsOf = text => {
    const values = new Set([...text.matchAll(/^export (?:class|const|function) (\w+)/gm)].map(match => match[1]))
    return exportedNames(text).map(name => `${values.has(name) ? '' : 'type '}${name}`).join(', ')
  }
  const types = author.between(file, 'type ClaudeAgentSdkThreadIdentity =', 'export class ClaudeCodeRootRefusalError')
  const runner = author.between(file, 'export interface ClaudeAgentSdkQueryRunnerShape',
    'const isClaudeAgentSdkQueryRunnerError =')
  const rules = author.between(file, 'const ClaudePermissionRules =', '// Without these, tools carry')
  const flag = 'type ClaudeFlagSettings = Parameters<ClaudeQuery["applyFlagSettings"]>[0];\n'
  const errorGuard = 'const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);\n'
  const error = author.between(file, 'function queryRunnerError(', 'function closeClaudeQuery(')
  const portParts = [types, runner, rules, flag, errorGuard, error, mcpError]
  author.derive(port, [selectedImports(original, portParts.join(''), file, port, redirects),
    ...portParts.map(text => author.sourcePart(file, text))], 'claude-original-query-port')
  const exportedPort = `${author.read(port).replace('type ClaudeAgentSdkThreadIdentity',
    'export type ClaudeAgentSdkThreadIdentity').replace('type ClaudeQueryStreamExit', 'export type ClaudeQueryStreamExit')
    .replace('const decodeClaudePermissionRules', 'export const decodeClaudePermissionRules')
    .replace('type ClaudeFlagSettings', 'export type ClaudeFlagSettings')
    .replace('class ClaudeMcpRegistrationTimeoutError', 'export class ClaudeMcpRegistrationTimeoutError')
    .replace('const isClaudeAgentSdkQueryRunnerError', 'export const isClaudeAgentSdkQueryRunnerError')
    .replace('function queryRunnerError', 'export function queryRunnerError')}`
  author.replace(port, author.read(port), exportedPort, 'claude-share-query-internals')
  const portNames = importsOf(exportedPort)
  author.replace(file, types, `import { ${portNames} } from "./ClaudeAdapterV2.session-port.ts";
export { ${portNames} };

`, 'claude-share-query-tag')
  for (const [text, id] of [[runner, 'runner'], [rules, 'rules'], [flag, 'flags'],
    [errorGuard, 'error-guard'], [error, 'error'], [mcpError, 'mcp-error']]) {
    author.replace(file, text, '', `claude-share-${id}`)
  }

  const logging = author.between(file, '// Iterate Query itself:', 'function makeClaudeAgentSdkProtocolLogger(')
  author.derive(protocol, [selectedImports(original, logging + turnStart, file, protocol, redirects),
    'import type { ClaudeAgentSdkQueryOptions, ClaudeFlagSettings } from "./ClaudeAdapterV2.session-port.ts";\n',
    author.sourcePart(file, logging), author.sourcePart(file, turnStart)], 'claude-original-query-protocol')
  author.replace(protocol, 'function isClaudeTurnStartMessage(', 'export function isClaudeTurnStartMessage(',
    'claude-share-original-turn-start')
  const loggingNames = importsOf(author.read(protocol))
  author.replace(file, logging, `import { ${loggingNames} } from "./ClaudeAdapterV2.session-protocol.ts";
export { ${loggingNames} };

`, 'claude-share-query-protocol')
  author.replace(file, turnStart, '', 'claude-application-shared-turn-start')

  // Rules moved above; close helper ends immediately before the preserved SDK comment.
  const controls = author.between(file, '            setModel: (model) =>', '            close: Queue.shutdown(promptQueue)')
  const messages = author.between(file, '            messages: Stream.fromAsyncIterable(',
    '            offer: (message, onQueued) =>')
  const queue = author.between(file, '          const promptQueue = yield* Queue.unbounded<SDKUserMessage>();',
    '          // Send MCP credentials over stdin')
  const diagnostics = author.between(file, '          let stderrTail = "";', '          const spawnProcess =')
  const constants = ['const CLAUDE_STDERR_TAIL_LENGTH =', 'const CLAUDE_STDERR_DRAIN_TIMEOUT =',
    'const CLAUDE_ROOT_REFUSAL =', 'const CLAUDE_MCP_REGISTRATION_TIMEOUT ='].map(start => {
    const first = original.indexOf(start)
    if (first < 0) throw new Error(`Missing original Claude constant: ${start}`)
    return original.slice(first, original.indexOf(';', first) + 1) + '\n'
  })
  const body = controlHelper + controls + messages + queue + refusal + configuration + constants.join('')
  author.derive(session, [selectedImports(original, body + ' ClaudeQueryOptions', file, session, redirects),
    'import { queryRunnerError, decodeClaudePermissionRules, ClaudeMcpRegistrationTimeoutError, type ClaudeAgentSdkQuerySession, type ClaudeAgentSdkQueryOpenInput } from "./ClaudeAdapterV2.session-port.ts";\n',
    'import { claudeQueryMessages, loggedClaudeQueryOptions, type ClaudeAgentSdkProtocolLogEvent } from "./ClaudeAdapterV2.session-protocol.ts";\n',
    ...constants.map(text => author.sourcePart(file, text)), author.sourcePart(file, refusal),
    author.sourcePart(file, controlHelper),
    `export const initializeClaudeQuery = (queryRuntime: ClaudeQuery, input: ClaudeAgentSdkQueryOpenInput,
  mcpServers: ClaudeQueryOptions["mcpServers"], logger?: (event: ClaudeAgentSdkProtocolLogEvent) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) => logger?.(event) ?? Effect.void;
`, author.sourcePart(file, configuration), `  });
`,
    `export function makeClaudeQueryControls(queryRuntime: ClaudeQuery,
  logger?: (event: ClaudeAgentSdkProtocolLogEvent) => Effect.Effect<void>) {
  const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) => logger?.(event) ?? Effect.void;
  return {
`, author.sourcePart(file, controls), `  } satisfies Omit<ClaudeAgentSdkQuerySession, "messages" | "offer" | "close">;
}
export interface ClaudeQueryDiagnostics {
  answered: boolean;
  stderrTail: string;
  stderrClosed: Promise<void>;
}
export function makeClaudeQueryDiagnostics(): ClaudeQueryDiagnostics {
  return { answered: false, stderrTail: "", stderrClosed: Promise.resolve() };
}
export function appendClaudeQueryStderr(diagnostics: ClaudeQueryDiagnostics, text: string) {
  if (diagnostics.answered) return;
  diagnostics.stderrTail = (diagnostics.stderrTail + text).slice(-CLAUDE_STDERR_TAIL_LENGTH);
}
export function makeClaudeQueryMessages(queryRuntime: ClaudeQuery, diagnostics: ClaudeQueryDiagnostics,
  logger?: (event: ClaudeAgentSdkProtocolLogEvent) => Effect.Effect<void>): ClaudeAgentSdkQuerySession["messages"] {
  const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) => logger?.(event) ?? Effect.void;
  return {
`, author.sourcePart(file, messages), `  }.messages;
}
export const makeClaudePromptQueue = <Message>() => Effect.gen(function* () {
`, author.sourcePart(file, queue), `  return { promptQueue, prompt };
});
`], 'claude-original-query-session')
  const emitted = author.read(session)
  const transformed = emitted.replaceAll('Queue.unbounded<SDKUserMessage>()', 'Queue.unbounded<Message>()')
    .replace(messages, messages.replaceAll('stderrClosed', 'diagnostics.stderrClosed')
      .replaceAll('stderrTail', 'diagnostics.stderrTail').replaceAll('answered', 'diagnostics.answered'))
  author.replace(session, emitted, transformed, 'claude-shared-query-state')
  author.replace(file, queue,
    '          const { promptQueue, prompt } = yield* makeClaudePromptQueue<SDKUserMessage>();\n',
    'claude-application-shared-prompt-queue')
  author.replace(file, messages,
    '            messages: makeClaudeQueryMessages(queryRuntime, diagnostics, logProtocolEvent),\n',
    'claude-application-shared-query-messages')
  author.replace(file, controls,
    '            ...makeClaudeQueryControls(queryRuntime, logProtocolEvent),\n',
    'claude-application-shared-query-controls')
  author.replace(file, configuration,
    '                    yield* initializeClaudeQuery(queryRuntime, input, mcpServers, logProtocolEvent);\n',
    'claude-application-shared-query-initialize')
  author.replace(file, diagnostics, `          const diagnostics = makeClaudeQueryDiagnostics();
          const appendStderr = (text: string) => appendClaudeQueryStderr(diagnostics, text);
`, 'claude-application-shared-query-diagnostics')
  author.replace(file, '                stderrClosed = new Promise((resolve) => (stderrDone = resolve));',
    '                diagnostics.stderrClosed = new Promise((resolve) => (stderrDone = resolve));',
    'claude-application-shared-stderr-drain')
  author.replace(file, controlHelper, '', 'claude-application-shared-control-helper')
  author.replace(file, refusal, '', 'claude-application-shared-root-refusal')
  for (const [index, text] of constants.entries()) author.replace(file, text, '', `claude-shared-constant:${index}`)
  const imports = `import { makeClaudePromptQueue, makeClaudeQueryControls, makeClaudeQueryMessages,
  makeClaudeQueryDiagnostics, appendClaudeQueryStderr, ClaudeCodeRootRefusalError, initializeClaudeQuery
} from "./ClaudeAdapterV2.session-query.ts";
export { ClaudeCodeRootRefusalError };
`
  const first = author.read(file).split('\n')[0]
  author.replace(file, first, imports + first, 'claude-application-shared-query-imports')
}
