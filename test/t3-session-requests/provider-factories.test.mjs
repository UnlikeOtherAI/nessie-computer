import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { createSourceModuleLoader } from '../t3-session-client-connection/module-loader.mjs'
import { sourceFunctions } from '../t3-session-client-connection/source-functions.mjs'
import { readRequestSource, scratch } from './source-fixture.mjs'

const { snapshot, privacy } = await readRequestSource()
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory: resolve(scratch, 'dependencies') })
const Effect = await loader.external('effect/Effect')
const activity = await loader.load('packages/shared/src/toolActivity.ts')
const toolOutput = await loader.load('packages/shared/src/toolOutput.ts')
const claude = 'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts'
const codex = 'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts'
const canary = ['synthetic', 'C05', 'private', 'č', '🧭'].join('-')
const value = ` \r\n${canary}\n `
const noCanary = item => assert.equal(JSON.stringify(item).includes(canary), false)
const nativeInput = sourceFunctions(snapshot, claude, 'function claudeNativeToolInputFromUnknown(',
  '// background_tasks_changed can include subagents already counted by their lifecycle.', ['claudeNativeToolInputFromRecord', 'claudeNativeToolInputValue',
    'inputRecordValue', 'firstStringInputField', 'jsonStringifyForTool'], { isClaudeNativeToolInputRecord: () => true })
const nativeOutput = sourceFunctions(snapshot, claude, 'function claudeNativeToolOutputValue(',
  'const decodeClaudeFileEditResult', ['claudeNativeToolOutputValue', 'claudeNativeToolOutputText'], {
    jsonStringifyForTool: nativeInput.jsonStringifyForTool,
    toolOutputImages: toolOutput.toolOutputImages, mcpToolResultOutput: toolOutput.mcpToolResultOutput,
    assertNever: () => { throw new Error('unexpected output variant') },
  })
const idAllocator = { derive: { nodeFromProviderItem: x => `node:${x.nativeItemId}`, turnItemFromProviderItem: x => `item:${x.nativeItemId}` } }
const { buildToolCallArtifacts } = sourceFunctions(snapshot, claude, '        const buildToolCallArtifacts = (input:',
  '        const emitToolCallArtifacts', ['buildToolCallArtifacts'], {
    ...privacy, ...nativeInput, ...nativeOutput, ...activity, idAllocator, CLAUDE_PROVIDER: 'claude',
    // Unrelated web-search/file helpers are inert in a dynamic-tool fixture.
    webSearchPatternsFromClaudeTool: () => [], webSearchResultsFromClaudeOutput: () => [],
  })

test('actual Claude tool factory excludes canaries on start, failure, completion and replay; originals remain executable', () => {
  const toolInput = nativeInput.claudeNativeToolInputFromRecord({ label: 'Token', reason: 'Required', value })
  for (const status of ['running', 'failed', 'completed', 'cancelled']) {
    const artifacts = buildToolCallArtifacts({
      context: null, nativeItemId: 'native:opaque', toolName: 'mcp__t3_code__request_secret',
      classification: { normalizedName: 'mcp', itemType: 'dynamic_tool' }, toolInput,
      threadId: 'thread:opaque', runId: null, rootNodeId: 'root', parentNodeId: 'root', ordinal: 9,
      output: { type: 'structured_tool_use_result', value: { error: value, content: [{ type: 'text', text: value }] } },
      status, startedAt: 1, updatedAt: 2, presentation: { title: value },
    })
    noCanary(artifacts)
    assert.equal(artifacts.turnItem.nativeItemRef.nativeId, 'native:opaque')
    assert.equal(artifacts.turnItem.ordinal, 9)
    assert.equal(artifacts.turnItem.status, status)
    assert.deepEqual(privacy.projectSecretRequestItem(artifacts.turnItem), artifacts.turnItem)
  }
  assert.equal(toolInput.value.value, value, 'provider callback retains exact original argument')
  const ordinary = buildToolCallArtifacts({ context: null, nativeItemId: 'normal', toolName: 'foreign.echo',
    classification: { normalizedName: 'mcp', itemType: 'dynamic_tool' }, toolInput,
    threadId: 't', runId: null, rootNodeId: 'root', parentNodeId: 'root', ordinal: 3,
    output: { type: 'content_block', value: 'ordinary result' }, status: 'completed', startedAt: 1, updatedAt: 2 })
  assert.equal(ordinary.turnItem.input.value, value)
  assert.equal(ordinary.turnItem.output, 'ordinary result')
})

const { codexDynamicToolOutput } = sourceFunctions(snapshot, codex, 'export function codexDynamicToolOutput(',
  'const projectCodexDynamicToolItem', ['codexDynamicToolOutput'], { CODEX_IMAGE_DATA_URL: /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i })
const { codexMcpToolOutput } = sourceFunctions(snapshot, codex, 'function codexMcpToolOutput(',
  '// A hung MCP resource', ['codexMcpToolOutput'], { mcpToolResultOutput: toolOutput.mcpToolResultOutput })
const { projectCodexDynamicToolItem } = sourceFunctions(snapshot, codex, 'const projectCodexDynamicToolItem =',
  'function codexNativeItemRef(', ['projectCodexDynamicToolItem'], {
    ...privacy, ...activity, Effect, codexDynamicToolOutput, codexMcpToolOutput,
    ...sourceFunctions(snapshot, codex, 'function trimText(', 'function codexPlanStepStatus(', ['trimText', 'nonEmptyText']),
    ...sourceFunctions(snapshot, codex, 'function codexItemStatus(', '/**\n * The composers let a skill', ['codexItemStatus']),
    // Real presentation needs a live server/Digest. This supplied metadata probes the factory boundary.
    mcpToolPresentation: () => Effect.succeed({ title: value }),
  })

test('actual Codex MCP and native dynamic factories exclude input, result, error and preview canaries', async () => {
  for (const type of ['mcpToolCall', 'dynamicToolCall']) {
    const item = { type, id: 'native:opaque', server: 't3-code-direct', namespace: 't3-code-direct',
      tool: 'request_secret', status: 'failed', arguments: { value, label: 'Token' },
      result: { structuredContent: { value }, content: [{ type: 'text', text: value }] },
      error: { message: value }, contentItems: [{ type: 'inputText', text: value }] }
    const projection = await Effect.runPromise(projectCodexDynamicToolItem(item))
    noCanary(projection)
    assert.equal(projection.toolName, 't3-code-direct.request_secret')
    assert.equal(projection.status, 'failed')
    assert.equal(item.arguments.value, value)
  }
})

test('actual Claude permission-result callback receives exact ephemeral arguments', () => {
  const { permissionResultFromDecision } = sourceFunctions(snapshot, claude, 'export function permissionResultFromDecision(',
    'function toSessionPermissionUpdates(', ['permissionResultFromDecision'])
  const input = { value }
  const result = permissionResultFromDecision({ toolName: 'mcp__t3_code__request_secret', decision: 'accept', toolInput: input, toolUseID: '__proto__' })
  assert.equal(result.updatedInput, input)
  assert.equal(result.updatedInput.value, value)
  assert.equal(result.toolUseID, '__proto__')
})

test('actual summaries and MCP preview selectors suppress registered secret values', () => {
  const { summarizeClaudeToolRequest } = sourceFunctions(snapshot, claude, 'function summarizeClaudeToolRequest(',
    'function outputFromClaudeToolResult(', ['summarizeClaudeToolRequest'], { ...privacy, ...nativeInput })
  assert.equal(summarizeClaudeToolRequest('mcp__t3_code__request_secret', nativeInput.claudeNativeToolInputFromRecord({ command: value, value })), 'Request a secret')
  const { codexMcpAppResourceUri } = sourceFunctions(snapshot, codex, 'function codexMcpAppResourceUri(',
    'const CODEX_IMAGE_DATA_URL', ['codexMcpAppResourceUri'], { ...privacy, MCP_APP_RESOURCE_SCHEME: 'ui://' })
  assert.equal(codexMcpAppResourceUri({ type: 'mcpToolCall', server: 't3-code', tool: 'request_secret', mcpAppResourceUri: 'ui://' + value }), undefined)
  assert.equal(codexMcpAppResourceUri({ type: 'mcpToolCall', server: 'foreign', tool: 'normal', mcpAppResourceUri: 'ui://app' }), 'ui://app')
})

test('actual native question helpers refuse masked fields before ordinary persistence and preserve ordinary text', async () => {
  const { claudeUserInputQuestions } = sourceFunctions(snapshot, claude, 'export function claudeUserInputQuestions(',
    'export function claudeSdkUserInputAnswers(', ['claudeUserInputQuestions'], privacy)
  const questions = [{ id: '__proto__', question: ' Jak dál? ', header: ' Dotaz ', isSecret: true, initialValue: value }]
  assert.throws(() => claudeUserInputQuestions({ questions }), /canonical_secret_question_port_required/)
  assert.equal(questions[0].initialValue, value)
  assert.equal(claudeUserInputQuestions({ questions: [{ ...questions[0], isSecret: false }] })[0].question, 'Jak dál?')
  const { buildUserInputRequestArtifacts } = sourceFunctions(snapshot, codex,
    '        const buildUserInputRequestArtifacts = Effect.fn(', '        yield* client.handleServerNotification("item/agentMessage/delta",',
    ['buildUserInputRequestArtifacts'], {
      ...privacy, Effect, DateTime: await loader.external('effect/DateTime'),
      CODEX_PROVIDER: 'codex',
      idAllocator: { allocate: { runtimeRequest: () => Effect.succeed('request:opaque') } },
    })
  await assert.rejects(Effect.runPromise(buildUserInputRequestArtifacts({
    context: { providerTurnId: 'turn:opaque', input: { providerThread: { providerSessionId: 'session:opaque' } } },
    nativeItemId: 'native:opaque', nativeRequestId: 'request:opaque', questions,
  })), /canonical_secret_question_port_required/)
})
