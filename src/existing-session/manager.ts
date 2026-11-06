import { basename, join } from 'node:path'

import { EXISTING_CODING_SESSION_OWNER_KEY } from '@nessie/executor-protocol'

import { buildAgentEnvironment } from '../coding-session/agent-env.js'
import { CodingBridgeError } from '../coding-session/bridge-tools.js'
import { ensureCodingStateDir, writeJsonAtomic } from '../coding-session/session-files.js'
import { existingAuthorityIsLive } from './authority.js'
import { pendingClaudeEvents } from './channel-delivery.js'
import { channelInboxDir } from './channel-files.js'
import { ExistingClaude } from './claude.js'
import { ExistingCodex } from './codex.js'
import { deliverOnce, latestExistingDelivery } from './delivery.js'
import { findProviderProgram } from './programs.js'
import { existingSessionsEnabled } from './settings.js'
import type { ExistingSession } from './types.js'

type Providers = { codex?: Pick<ExistingCodex, 'list' | 'read' | 'queue' | 'close' | 'program' | 'nextCursor'> & { listAll?: () => Promise<ExistingSession[]> };
  claude?: Pick<ExistingClaude, 'list' | 'program' | 'read'> }

export class ExistingSessions {
  private providers: Promise<Providers> | undefined
  private rows: ExistingSession[] = []
  private refreshedAt = 0
  private providerStatus: Record<string, string> = {}
  private readonly discovered = new Map<string, ExistingSession>()
  private refreshing: Promise<ExistingSession[]> | undefined
  private lastQueuedAt = 0
  private serial: Promise<unknown> = Promise.resolve()

  constructor(private readonly stateDir: string, private readonly providerFactory?: () => Promise<Providers>) {}

  private connect() {
    this.providers ??= this.providerFactory ? this.providerFactory() : (async () => {
      const env = await buildAgentEnvironment({ config: { inheritUserSession: true, pass: [], set: {} } })
      const [codex, claude] = await Promise.all([findProviderProgram('codex', env), findProviderProgram('claude', env)])
      return { ...(codex ? { codex: new ExistingCodex(codex, env) } : {}),
        ...(claude ? { claude: new ExistingClaude(claude, env, this.stateDir) } : {}) }
    })()
    return this.providers
  }

  async enabled(): Promise<boolean> {
    const enabled = await existingSessionsEnabled(this.stateDir)
    if (!enabled) {
      this.rows = []
      this.discovered.clear()
      this.refreshedAt = 0
      if (this.providers) (await this.providers).codex?.close()
      this.providers = undefined
    }
    return enabled
  }

  async list(fresh = false): Promise<ExistingSession[]> {
    if (!await this.enabled()) return []
    if (!fresh && Date.now() - this.refreshedAt < 60_000) return this.rows
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const providers = await this.connect()
      const results = await Promise.allSettled([
        providers.codex?.listAll?.() ?? providers.codex?.list() ?? [], providers.claude?.list() ?? [],
      ])
      this.providerStatus = Object.fromEntries((['codex', 'claude'] as const).map((name, index) => [
        name, !providers[name] ? 'not_installed' : results[index]!.status === 'fulfilled' ? 'available' : 'unavailable',
      ]))
      this.rows = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 5000)
      this.remember(this.rows)
      this.refreshedAt = Date.now()
      return await this.enabled() ? this.rows : []
    })()
    try { return await this.refreshing } finally { this.refreshing = undefined }
  }

  private remember(rows: ExistingSession[]): void {
    for (const row of rows) { this.discovered.delete(row.sessionId); this.discovered.set(row.sessionId, row) }
    while (this.discovered.size > 5000) this.discovered.delete(this.discovered.keys().next().value!)
  }

  async page(provider?: 'codex' | 'claude', cursor?: string, search?: string): Promise<Record<string, unknown>> {
    if (!await this.enabled()) return { sessions: [], disabled: true }
    const providers = await this.connect()
    const selected = (['codex', 'claude'] as const).filter((name) => !provider || name === provider)
    const results = await Promise.allSettled(selected.map(async (name) => {
      if (name === 'codex') return await providers.codex?.list(cursor, search) ?? []
      return (await providers.claude?.list() ?? []).filter((row) => (
        !search || row.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      ))
    }))
    selected.forEach((name, index) => {
      this.providerStatus[name] = !providers[name] ? 'not_installed'
        : results[index]!.status === 'fulfilled' ? 'available' : 'unavailable'
    })
    const rows = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    if (!await this.enabled()) return { sessions: [], disabled: true }
    this.remember(rows)
    return { providers: this.providerStatus, sessions: rows,
      ...(provider !== 'claude' && providers.codex?.nextCursor
        ? { nextCursor: providers.codex.nextCursor, nextCursorProvider: 'codex' } : {}) }
  }

  async find(id: string): Promise<ExistingSession | undefined> {
    await this.list()
    return this.discovered.get(id)
  }

  async inventory(): Promise<Record<string, unknown>[]> {
    if (!await existingAuthorityIsLive(this.stateDir)) return []
    return (await this.list()).map((row) => ({ sessionId: row.sessionId, ownerKey: EXISTING_CODING_SESSION_OWNER_KEY,
      origin: 'external', title: row.title, status: row.status, agent: row.provider,
      root: basename(row.cwd) || 'existing', updatedAt: row.updatedAt }))
  }

  async read(id: string, includeText = false): Promise<Record<string, unknown>> {
    const session = await this.find(id)
    if (!session) {
      throw new CodingBridgeError('coding_session_not_found', 'Existing session is unavailable or access is disabled.')
    }
    const providers = await this.connect()
    const result = session.provider === 'codex'
      ? await providers.codex?.read(session, includeText) : await providers.claude?.read(session, includeText)
    if (!result) throw new CodingBridgeError('coding_session_not_found', 'The provider connection is unavailable.')
    const lastDelivery = await latestExistingDelivery(this.stateDir, id)
    return { ...result, ...(lastDelivery ? { lastDelivery } : {}) }
  }

  async send(
    action: string, id: string, message: string, ownerKey: string, commandId: string,
  ): Promise<Record<string, unknown>> {
    const work = async (): Promise<Record<string, unknown>> => {
      const current = await this.list(true)
      const remembered = this.discovered.get(id)
      const session = current.find((row) => row.sessionId === id)
        ?? (remembered?.provider === 'codex' ? remembered : undefined)
      if (!session) {
        throw new CodingBridgeError('coding_session_not_found', 'Existing session is unavailable or access is disabled.')
      }
      if ((action !== 'queue' || !session.capabilities.queue) && (action !== 'push' || !session.capabilities.push)) {
        throw new CodingBridgeError('coding_session_action_unavailable', session.capabilities.reason)
      }
      const providers = await this.connect()
      if (session.provider === 'codex' && !providers.codex || session.provider === 'claude' && !providers.claude) {
        throw new CodingBridgeError('coding_session_action_unavailable', 'The native provider is unavailable.')
      }
      if (session.provider === 'codex') await providers.codex!.read(session, false)
      const attributed = `[Nessie · ${ownerKey.slice(7, 19)} · ${commandId}]\n${message}`
      return deliverOnce({
        stateDir: this.stateDir, commandId, ownerKey, sessionId: id, action, message, send: async (eventId) => {
        if (!await this.enabled()) return { state: 'cancelled', reason: 'Existing coding sessions were disabled.' }
        if (session.provider === 'codex') return providers.codex!.queue(session, attributed, commandId)
        const inbox = channelInboxDir(this.stateDir, id)
        await ensureCodingStateDir(inbox)
        if (await pendingClaudeEvents(inbox) >= 32) {
          return { state: 'failed', reason: 'The Claude channel already has 32 pending events.' }
        }
        this.lastQueuedAt = Math.max(Date.now(), this.lastQueuedAt + 1)
        await writeJsonAtomic(join(inbox, `${eventId}.pending`), {
          queuedAt: this.lastQueuedAt,
          commandId, sessionId: id, incarnation: session.incarnation, message: attributed,
          expiresAt: Date.now() + 60_000,
        })
        return { state: 'accepted_locally', providerMessageId: commandId,
          behavior: 'Waiting for the Claude channel to write the event. Consumption is not acknowledged.' }
      } })
    }
    const running = this.serial.then(work, work)
    this.serial = running.catch(() => undefined)
    return running
  }

  async close(): Promise<void> { if (this.providers) (await this.providers).codex?.close() }
}
