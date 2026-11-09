import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionClaudeQuery, SessionClaudePrompt, SessionClaudeProcess, SessionClaudeDescriptor }
  from '@nessie/t3-session-source/claude-sdk'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
export type ActualOriginalQuery = Assert<Equal<SessionClaudeQuery['query'], Query>>
declare const handle: SessionClaudeQuery
declare const child: SessionClaudeProcess
declare const message: SDKUserMessage
declare const captured: SessionClaudePrompt
declare const descriptor: SessionClaudeDescriptor
handle.capturePrompt(message)
handle.streamInput({ messages: (async function* () { yield captured })(), interrupt: async () => {} })
// @ts-expect-error Only private captured tokens enter the native input loop.
handle.streamInput({ messages: (async function* () { yield message })(), interrupt: async () => {} })
// @ts-expect-error Native process intentionally exposes no generic stdin.
child.stdin.write('unsafe')
// @ts-expect-error Captured descriptor arguments cannot change after hold.
descriptor.args.push('--changed')
// @ts-expect-error A serialized marker cannot construct a private capture.
const forged: SessionClaudePrompt = { type: 'user', acknowledged: Promise.resolve() }
void forged
