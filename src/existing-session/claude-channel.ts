import { unlink } from 'node:fs/promises'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { buildAgentEnvironment } from '../coding-session/agent-env.js'
import { ensureCodingStateDir, writeJsonAtomic } from '../coding-session/session-files.js'
import { loadExecutorState } from '../state-store.js'
import { existingAuthorityIsLive } from './authority.js'
import { channelInboxDir, channelRegistrationPath, channelsDir } from './channel-files.js'
import { drainClaudeChannel } from './channel-delivery.js'
import { claudeAgents, ExistingClaude } from './claude.js'
import { findProviderProgram } from './programs.js'
import { existingSessionsEnabled } from './settings.js'

/** Claude starts this MCP process. Its native agent registry binds the parent PID to the session incarnation. */
export const serveExistingClaudeChannel = async (stateDir: string): Promise<void> => {
  await loadExecutorState(stateDir)
  const env = await buildAgentEnvironment({ config: { inheritUserSession: true, pass: [], set: {} } })
  const program = await findProviderProgram('claude', env)
  if (!program) throw new Error('Claude Code was not found for this OS account.')
  const agents = await claudeAgents(program.path, env)
  const parent = agents.find((agent) => agent.pid === process.ppid)
  if (!parent) throw new Error('Start this channel from Claude Code; its native session identity could not be verified.')
  const provider = new ExistingClaude(program, env, stateDir)
  const session = (await provider.list()).find((row) => row.nativeId === parent.sessionId)
  if (!session?.incarnation) throw new Error('Claude did not provide a native session incarnation.')
  await ensureCodingStateDir(channelsDir(stateDir))
  const inbox = channelInboxDir(stateDir, session.sessionId)
  await ensureCodingStateDir(inbox)
  const registration = channelRegistrationPath(stateDir, session.sessionId)
  const server = new Server({ name: 'nessie', version: '1.0.0' }, {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  await server.connect(new StdioServerTransport())
  let stopped = false
  let running = false
  let lastIdentityCheck = 0
  const stop = (): void => { stopped = true; clearInterval(timer); void unlink(registration).catch(() => undefined) }
  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      if (Date.now() - lastIdentityCheck > 5_000) {
        const current = await claudeAgents(program.path, env)
        if (!current.some((agent) => agent.sessionId === session.nativeId
          && `${String(agent.pid)}:${String(agent.startedAt)}` === session.incarnation)) { stop(); return }
        lastIdentityCheck = Date.now()
      }
      const enabled = await existingSessionsEnabled(stateDir) && await existingAuthorityIsLive(stateDir)
      if (enabled) await writeJsonAtomic(registration, {
        nativeId: session.nativeId, profile: provider.profile, incarnation: session.incarnation,
        heartbeatAt: Date.now(),
      })
      else await unlink(registration).catch(() => undefined)
      await drainClaudeChannel({ stateDir, sessionId: session.sessionId, incarnation: session.incarnation!,
        notify: async (event) => server.notification({ method: 'notifications/claude/channel', params: {
          content: event.message, meta: { source: 'Nessie', message_id: event.commandId },
        } }),
      })
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick().catch(stop) }, 1_000)
  server.onclose = stop
  process.stdin.once('end', stop)
  await tick()
}
