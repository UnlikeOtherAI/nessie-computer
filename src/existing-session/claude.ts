import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand } from '../coding-session/agent-env.js'
import { readJson } from '../coding-session/session-files.js'
import { channelRegistrationPath, type ChannelRegistration } from './channel-files.js'
import { readNativeTranscript } from './transcript.js'
import { listSavedClaudeSessions } from './claude-saved.js'
import { readClaudeRecentMessages } from './claude-history.js'
import type { ProviderProgram } from './programs.js'
import { existingSessionId, nativeIdIsValid, objectOf, textOf, type ExistingSession } from './types.js'

export const claudeAgents = async (program: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>[]> => {
  const result = await runCommand(program, ['agents', '--json'], { env, timeoutMs: 10_000, maxBytes: 256 * 1024 })
  if (result.code !== 0) throw new Error('Claude active-session discovery is unavailable.')
  const value: unknown = JSON.parse(result.stdout)
  if (!Array.isArray(value)) throw new Error('Claude active-session discovery is unavailable.')
  return value.map(objectOf)
}

export class ExistingClaude {
  readonly profile: string
  private transcriptPaths = new Map<string, string[]>()
  constructor(
    readonly program: ProviderProgram, private readonly env: NodeJS.ProcessEnv, private readonly stateDir: string,
  ) {
    this.profile = resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  }

  async list(): Promise<ExistingSession[]> {
    const [agents, saved] = await Promise.all([
      claudeAgents(this.program.path, this.env), listSavedClaudeSessions(this.profile),
    ])
    this.transcriptPaths = new Map()
    for (const row of saved) {
      const paths = this.transcriptPaths.get(row.session.sessionId) ?? []
      paths.push(row.path)
      this.transcriptPaths.set(row.session.sessionId, paths)
    }
    const rows: ExistingSession[] = []
    for (const agent of agents) {
      if (!nativeIdIsValid(agent.sessionId) || typeof agent.pid !== 'number' || !agent.startedAt) continue
      const sessionId = existingSessionId('claude', this.profile, agent.sessionId)
      const incarnation = `${agent.pid}:${String(agent.startedAt)}`
      const registration = await readJson<ChannelRegistration>(channelRegistrationPath(this.stateDir, sessionId))
      const connected = registration?.incarnation === incarnation && registration.nativeId === agent.sessionId
        && registration.profile === this.profile && Date.now() - registration.heartbeatAt < 10_000
      rows.push({ sessionId, nativeId: agent.sessionId, provider: 'claude', incarnation,
        title: textOf(agent.name) || 'Claude session', cwd: textOf(agent.cwd, 4_096),
        status: agent.status === 'busy' ? 'working' : agent.status === 'idle' ? 'waiting_for_input' : 'unknown',
        updatedAt: new Date().toISOString(), client: textOf(agent.kind) || 'Claude Code',
        capabilities: { queue: false, push: connected, steer: false, interrupt: false,
          reason: connected ? 'Experimental Claude channel event. May be consumed during a turn; no consumption acknowledgement.'
            : 'This session has no connected Nessie channel. Claude requires its channel configuration and startup opt-in.' },
      })
    }
    const active = new Set(rows.map((row) => row.sessionId))
    return [...rows, ...saved.filter((row) => !active.has(row.session.sessionId)).map((row) => row.session)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId))
  }

  async read(session: ExistingSession, includeText: boolean): Promise<Record<string, unknown>> {
    const candidates = this.transcriptPaths.get(session.sessionId) ?? []
    if (includeText && candidates.length > 1) {
      return { ...session, origin: 'external', historyAvailable: false, historyState: 'ambiguous',
        historyCandidateCount: candidates.length, observedAt: new Date().toISOString() }
    }
    const filename = candidates[0]
    const conversation = includeText && filename
      ? await readNativeTranscript('claude', join(this.profile, 'projects'), filename, session.nativeId) : null
    return { ...session, ...(conversation ? { conversation: { ...conversation, capturedAt: new Date().toISOString(),
      sendMode: session.capabilities.push ? 'push' : null, canInterrupt: false } } : {}), origin: 'external', observedAt: new Date().toISOString(),
      providerVersion: this.program.version, observation: 'Claude native active-session registry.',
      ...(includeText && filename ? await readClaudeRecentMessages(
        this.profile, session, filename,
      ) : {}) }
  }
}
