import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const shared = 'packages/shared/src/t3McpToolPresentation.ts'
const claude = 'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts'
const codex = 'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts'

/** Authoring helper only. No parser, resolver, extraction or producer implementation. */
export const buildRequestPrivacyManifest = snapshot => {
  const patches = []
  const modified = new Map()
  const patch = (id, file, from, to) => {
    const before = modified.get(file) ?? snapshot.read(file).toString()
    if (before.split(from).length !== 2) throw new Error(`NON_UNIQUE_PATCH_SEAM:${id}`)
    const after = before.replace(from, to)
    patches.push({ id, file, beforeSha256: hash(before), afterSha256: hash(after), from, to })
    modified.set(file, after)
  }
  const helper = readFileSync(new URL('../../patches/t3-session/requests/tool-privacy.ts', import.meta.url), 'utf8')
  const sharedTail = '  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };\n}\n'
  patch('request-privacy-structural-projections', shared, sharedTail, `${sharedTail}\n${helper}`)
  patch('request-secret-exact-wire-value', 'packages/contracts/src/secretRequest.ts',
    'Schema.Struct({ type: Schema.Literal("save"), secret: TrimmedNonEmptyString })',
    'Schema.Struct({ type: Schema.Literal("save"), secret: Schema.String.check(\n' +
    '      Schema.makeFilter((value: string) => value.length > 0, { expected: "a non-empty string" }),\n' +
    '    ) })')
  patch('request-secret-remove-unused-trim-import', 'packages/contracts/src/secretRequest.ts',
    'import { ThreadId, TrimmedNonEmptyString, TurnItemId }', 'import { ThreadId, TurnItemId }')
  patch('request-secret-exact-client-value', 'packages/client-runtime/src/secretRequest.ts',
    'const secret = answer.secret.trim();', 'const secret = answer.secret;')
  const imports = 'import {\n  assertPublicUserInputQuestions, createRequestPrivacyProjector, isSecretRequestTool,\n' +
    '  projectSecretRequestInput, projectSecretRequestOutput, projectSecretRequestItem,\n' +
    '} from "@t3tools/shared/t3McpToolPresentation";\n'
  for (const [name, file] of [['claude', claude], ['codex', codex]]) {
    // Per-adapter imports include only used symbols. Neither imports a vault or cache implementation.
    const selected = name === 'claude' ? imports : imports.replace('  projectSecretRequestInput, projectSecretRequestOutput, projectSecretRequestItem,',
      '  projectSecretRequestItem,')
    const firstImport = snapshot.read(file).toString().split('\n')[0]
    patch(`${name}-request-privacy-import`, file, firstImport, `${selected}${firstImport}`)
    const logger = name === 'claude' ? 'function makeClaudeAgentSdkProtocolLogger' : 'export function makeCodexAppServerProtocolLogger'
    const text = modified.get(file)
    const start = text.indexOf(logger)
    const seam = text.slice(start, text.indexOf('  return (event) => {', start)) + '  return (event) => {'
    patch(`${name}-private-protocol-projector`, file, seam,
      seam.replace('  return (event) => {', '  const projectRequestPrivacy = createRequestPrivacyProjector();\n\n  return (event) => {'))
    const event = name === 'claude'
      ? 'event: boundProviderEventForLogging(event),'
      : 'event: redactCodexProtocolValue(boundProviderEventForLogging(event)),'
    patch(`${name}-private-protocol-before-bounds`, file, event, name === 'claude'
      ? 'event: boundProviderEventForLogging(projectRequestPrivacy(event)),'
      : 'event: redactCodexProtocolValue(boundProviderEventForLogging(projectRequestPrivacy(event))),')
  }
  patch('claude-private-tool-title-input', claude,
    'const nativeToolInput = claudeNativeToolInputValue(input.toolInput);',
    'const nativeToolInput = projectSecretRequestInput(\n            input.toolName, claudeNativeToolInputValue(input.toolInput),\n          );')
  patch('claude-private-tool-output', claude,
    'const outputValue = claudeNativeToolOutputValue(input.output);',
    'const outputValue = projectSecretRequestOutput(\n            input.toolName, claudeNativeToolOutputValue(input.output),\n          );')
  patch('claude-private-tool-input', claude,
    'input: claudeNativeToolInputValue(input.toolInput),', 'input: nativeToolInput,')
  patch('claude-private-tool-factory-final', claude,
    '          return { node, turnItem };\n        };\n\n        const emitToolCallArtifacts',
    '          return { node, turnItem: turnItem.type === "dynamic_tool"\n' +
    '            ? projectSecretRequestItem(turnItem) : turnItem };\n        };\n\n        const emitToolCallArtifacts')
  patch('claude-masked-question-before-tool-event', claude,
    '          const nativeToolInput = projectSecretRequestInput(\n            input.toolName, claudeNativeToolInputValue(input.toolInput),\n          );',
    '          const nativeToolInput = projectSecretRequestInput(\n            input.toolName, claudeNativeToolInputValue(input.toolInput),\n          );\n' +
    '          if (input.toolName === "AskUserQuestion") {\n' +
    '            assertPublicUserInputQuestions(inputRecordValue(input.toolInput, "questions"));\n          }')
  patch('claude-private-tool-summary', claude,
    'function summarizeClaudeToolRequest(toolName: string, input: ClaudeNativeToolInput): string {',
    'function summarizeClaudeToolRequest(toolName: string, input: ClaudeNativeToolInput): string {\n' +
    '  if (isSecretRequestTool(toolName)) return "Request a secret";')
  patch('claude-private-approval-prompt', claude,
    '          const prompt =\n            (typeof command',
    '          const prompt = isSecretRequestTool(toolName) ? "Request a secret" :\n            (typeof command')
  patch('claude-private-approval-reason', claude,
    '              prompt,\n              callbackOptions,\n            }),',
    '              prompt,\n              callbackOptions: isSecretRequestTool(toolName) ? {\n' +
    '                matchedAskRule: callbackOptions.matchedAskRule,\n' +
    '                suppressAlwaysAllowRule: callbackOptions.suppressAlwaysAllowRule,\n' +
    '              } : callbackOptions,\n            }),')
  patch('claude-private-preview-refusal', claude,
    '              !toolCall.toolName.startsWith("mcp__") ||',
    '              isSecretRequestTool(toolCall.toolName) ||\n              !toolCall.toolName.startsWith("mcp__") ||')
  patch('codex-private-preview-refusal', codex,
    '  if (item.type !== "mcpToolCall") return undefined;',
    '  if (item.type !== "mcpToolCall" || isSecretRequestTool(`${item.server}.${item.tool}`)) return undefined;')
  patch('claude-masked-question-admission', claude,
    '  if (!Array.isArray(questions)) return [];\n  return questions.flatMap',
    '  if (!Array.isArray(questions)) return [];\n  assertPublicUserInputQuestions(questions);\n  return questions.flatMap')
  patch('codex-private-tool-factory', codex,
    '  return output === undefined ? projection : { ...projection, output };',
    '  return projectSecretRequestItem(output === undefined ? projection : { ...projection, output });')
  patch('codex-masked-question-admission', codex,
    '          const questions = input.questions.map((question, index) => ({',
    '          assertPublicUserInputQuestions(input.questions);\n          const questions = input.questions.map((question, index) => ({')
  patch('codex-masked-async-question-admission', codex,
    '            if (payload.item.delivery === "async" && payload.item.questions?.length) {',
    '            if (payload.item.delivery === "async" && payload.item.questions?.length) {\n' +
    '              assertPublicUserInputQuestions(payload.item.questions);')
  // Last interception protects late preview/app overrides as well as ordinary factory events.
  for (const [name, file] of [['claude', claude], ['codex', codex]]) {
    const seam = name === 'claude'
      ? '          return Queue.offer(events, event).pipe(Effect.asVoid);'
      : '        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>\n          Queue.offer(events, event).pipe(Effect.asVoid);'
    const projection = 'event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"\n' +
      '              ? { ...event, turnItem: projectSecretRequestItem(event.turnItem) } : event'
    const to = name === 'claude'
      ? `          return Queue.offer(events, ${projection}).pipe(Effect.asVoid);`
      : `        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>\n          Queue.offer(events, ${projection}).pipe(Effect.asVoid);`
    patch(`${name}-private-tool-before-publication`, file, seam, to)
  }
  return Buffer.from(`${JSON.stringify({ format: 1, sourceCommit: snapshot.identity.commit, patches }, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const snapshot = await readSessionEngineSnapshot(process.argv[2])
  const bytes = buildRequestPrivacyManifest(snapshot)
  writeFileSync(new URL('../../patches/t3-session/requests/boundary-patches.json', import.meta.url), bytes)
  console.log(JSON.stringify({ sha256: hash(bytes), patches: JSON.parse(bytes).patches.length }))
}
