import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand } from '../coding-session/agent-env.js'
import { readJson } from '../coding-session/session-files.js'
import { channelRegistrationPath, type ChannelRegistration } from './channel-files.js'
import { readClaudeRecentMessages } from './claude-history.js'
import type { ProviderProgram } from './programs.js'
import { existingSessionId, nativeIdIsValid, objectOf, textOf, type ExistingSession } from './types.js'

export const claudeAgents = async (program: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>[]> => {
  const result = await runCommand(program, ['agents', '--json'], { env, timeoutMs: 10_000, maxBytes: 256 * 1024 })
  if (result.code !== 0) throw new Error('Claude active-session discovery is unavailable.')
  const value: unknown = JSON.parse(result.stdout)
  return (Array.isArray(value) ? value : []).slice(0, 128).map(objectOf)
}

export class ExistingClaude {
  readonly profile: string
  constructor(
    readonly program: ProviderProgram, private readonly env: NodeJS.ProcessEnv, private readonly stateDir: string,
  ) {
    this.profile = resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  }

  async list(): Promise<ExistingSession[]> {
    const agents = await claudeAgents(this.program.path, this.env)
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
    return rows.slice(0, 32)
  }

  async read(session: ExistingSession, includeText: boolean): Promise<Record<string, unknown>> {
    return { ...session, origin: 'external', observedAt: new Date().toISOString(),
      providerVersion: this.program.version, observation: 'Claude native active-session registry.',
      ...(includeText ? await readClaudeRecentMessages(this.profile, session) : {}) }
  }
}
