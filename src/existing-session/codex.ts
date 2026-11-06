import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { readNativeTranscript } from './transcript.js'
import { CodexRpc } from '../provider-process/codex-rpc.js'
import type { ProviderProgram } from './programs.js'
import { existingSessionId, nativeIdIsValid, objectOf, textOf, type ExistingSession } from './types.js'

const QUEUE_BEHAVIOR = 'Experimental Codex native queue. The original client decides when to consume input; '
  + 'Desktop may consume it during its current turn. Acceptance does not confirm consumption.'

/**
 * A thread's runtime status as this app-server sees it. A thread another
 * client has open is `notLoaded` here, which says nothing about whether it is
 * running: that, and anything unrecognised, stays unknown, never idle.
 */
const statusOf = (value: unknown): ExistingSession['status'] => {
  const type = objectOf(value).type
  return type === 'active' ? 'working' : type === 'idle' ? 'waiting_for_input' : 'unknown'
}

export class ExistingCodex {
  readonly profile: string
  private readonly rpc: Pick<CodexRpc, 'call' | 'close'>
  private queueSupported: boolean | undefined
  nextCursor: string | null = null

  constructor(readonly program: ProviderProgram, env: NodeJS.ProcessEnv, rpc?: Pick<CodexRpc, 'call' | 'close'>) {
    this.profile = resolve(env.CODEX_HOME ?? join(homedir(), '.codex'))
    this.rpc = rpc ?? new CodexRpc(program.path, env)
  }

  private project(value: unknown): ExistingSession | undefined {
    const thread = objectOf(value)
    if (!nativeIdIsValid(thread.id)) return undefined
    const observed = typeof thread.updatedAt === 'number' ? new Date(thread.updatedAt * 1_000) : new Date()
    if (!Number.isFinite(observed.getTime())) return undefined
    return {
      sessionId: existingSessionId('codex', this.profile, thread.id), nativeId: thread.id, provider: 'codex',
      title: textOf(thread.name || thread.preview) || 'Codex session', cwd: textOf(thread.cwd, 4_096),
      status: statusOf(thread.status), updatedAt: observed.toISOString(), client: textOf(thread.source) || 'Codex',
      capabilities: { queue: this.queueSupported === true && thread.canAcceptDirectInput !== false,
        push: false, steer: false, interrupt: false,
        reason: this.queueSupported ? QUEUE_BEHAVIOR : 'This Codex build does not expose the experimental native queue.' },
    }
  }

  async list(cursor?: string, search?: string): Promise<ExistingSession[]> {
    const result = objectOf(await this.rpc.call('thread/list', {
      limit: 32, sortKey: 'updated_at', archived: false, useStateDbOnly: true, modelProviders: [],
      ...(cursor ? { cursor } : {}), ...(search ? { searchTerm: search } : {}) }))
    this.nextCursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
    const threads = Array.isArray(result.data) ? result.data : []
    const first = threads.map(objectOf).find((thread) => nativeIdIsValid(thread.id))
    if (this.queueSupported !== true && first) {
      this.queueSupported = await this.rpc.call('thread/queue/list', { threadId: first.id })
        .then(() => true, () => false)
    }
    return threads.flatMap((thread) => { const row = this.project(thread); return row ? [row] : [] })
  }

  async listAll(): Promise<ExistingSession[]> {
    const rows: ExistingSession[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    do {
      const page = await this.list(cursor)
      rows.push(...page.filter((row) => Date.parse(row.updatedAt) >= cutoff))
      if (!this.nextCursor || cursors.has(this.nextCursor) || rows.length >= 5000
        || (page.length > 0 && page.every((row) => Date.parse(row.updatedAt) < cutoff))) break
      cursor = this.nextCursor
      cursors.add(cursor)
    } while (true)
    return rows.slice(0, 5000)
  }

  async read(session: ExistingSession, includeText: boolean): Promise<Record<string, unknown>> {
    const result = objectOf(await this.rpc.call('thread/read', {
      threadId: session.nativeId, includeTurns: false,
    }))
    const thread = objectOf(result.thread)
    if (thread.id !== session.nativeId) throw new Error('Codex returned a different thread.')
    const conversation = includeText && typeof thread.path === 'string'
      ? await readNativeTranscript('codex', join(this.profile, 'sessions'), thread.path, session.nativeId) : null
    const full = includeText && !conversation ? objectOf(await this.rpc.call('thread/read', {
      threadId: session.nativeId, includeTurns: true,
    })) : { thread }
    const turns = Array.isArray(objectOf(full.thread).turns) ? objectOf(full.thread).turns as unknown[] : []
    const records = turns.map(objectOf)
    const last = records.at(-1)
    const text = includeText && conversation ? conversation.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant').slice(-4)
      .map((message) => ({ role: message.role, text: message.parts.filter((part) => part.kind === 'text')
        .map((part) => part.text).join('\n').slice(0, 4000) })) : includeText ? records.slice(-3).flatMap((turn) => (
      Array.isArray(turn.items) ? turn.items.map(objectOf).flatMap((item) => {
        if (item.type === 'agentMessage') return [{ role: 'assistant', text: textOf(item.text, 4_000) }]
        if (item.type !== 'userMessage' || !Array.isArray(item.content)) return []
        return [{ role: 'user', text: item.content.map(objectOf).filter((part) => part.type === 'text')
          .map((part) => textOf(part.text, 2_000)).join('\n').slice(0, 4_000) }]
      }) : []
    )).slice(-4) : undefined
    return { ...session, ...(conversation ? { conversation: { ...conversation,
      capturedAt: new Date().toISOString(), sendMode: session.capabilities.queue ? 'queue' : null,
      canInterrupt: false } } : {}), origin: 'external', providerVersion: this.program.version,
      observedAt: new Date().toISOString(), observation: 'Saved native thread; live runtime state is unknown.',
      ...(last ? { lastRecordedTurn: { id: last.id, status: last.status } } : {}),
      ...(text ? { recentMessages: text } : {}) }
  }

  async queue(session: ExistingSession, message: string, messageId: string): Promise<Record<string, unknown>> {
    if (!this.queueSupported) throw new Error('The experimental Codex queue is unavailable.')
    const result = objectOf(await this.rpc.call('thread/queue/add', {
      threadId: session.nativeId, clientUserMessageId: messageId,
      input: [{ type: 'text', text: message, text_elements: [] }],
    }))
    return { state: 'queued_natively', providerMessageId: messageId,
      ...(typeof objectOf(result.queuedSubmission).id === 'string' ? { nativeQueueId: objectOf(result.queuedSubmission).id } : {}),
      behavior: QUEUE_BEHAVIOR }
  }

  close(): void { this.rpc.close() }
}
