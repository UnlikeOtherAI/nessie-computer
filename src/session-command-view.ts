import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import type { SessionCommandStatus, SessionCommandView } from './session-snapshot.js'

/**
 * What one held command works on, in the fields the console words ("running
 * `npm test`", "reading report.md", "browsing docs.example.com", "using
 * kelpie"). It is the owner's own computer and owner-only state, so a
 * program's arguments may appear; the apps write the sentence. A field this
 * cannot tell is left out, and the console then says "working".
 */

const FIELD_MAX_CHARS = 200
const ARGS_MAXIMUM = 32

const record = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)
const clip = (value: string): string => (value.length > FIELD_MAX_CHARS ? `${value.slice(0, FIELD_MAX_CHARS - 1)}…` : value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? clip(value) : undefined)
const strings = (value: unknown): string[] | undefined => (
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[]).slice(0, ARGS_MAXIMUM).map(clip) : undefined
)
const hostOf = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined
  try { return new URL(url).hostname || undefined } catch { return undefined }
}

const launch = (program: string | undefined, args: string[] | undefined) => (
  program ? { program, ...(args?.length ? { args } : {}) } : {}
)

export const sessionCommandView = (
  command: ExecutorCommandEnvelope,
  status: SessionCommandStatus,
  context: {
    /** The coding-sessions bridge's server name, when the team has one. */
    bridge?: string
    /** The host the command's run last opened in its browser. */
    site?: string
    requestId?: string
  },
): SessionCommandView | undefined => {
  const args = record(command.payload.args)
  const base = { id: command.commandId, status, ...(context.requestId ? { requestId: context.requestId } : {}) }
  const key = command.operationKey
  if (key === 'command.run') {
    return { ...base, kind: 'program', ...launch(text(args?.program), strings(args?.args)) }
  }
  if (key === 'file.read' || key === 'file.list' || key === 'file.write') {
    const path = text(args?.path)
    return { ...base, kind: 'file', operation: key === 'file.write' ? 'write' : 'read', ...(path ? { path } : {}) }
  }
  if (key === 'workspace.review') return { ...base, kind: 'file', operation: 'read' }
  if (key === 'workspace.promote') return { ...base, kind: 'file', operation: 'write' }
  if (key.startsWith('browser.')) {
    const site = hostOf(args?.url) ?? context.site
    return { ...base, kind: 'browser', ...(site ? { site } : {}) }
  }
  if (key === 'coding.launch' || key === 'coding.observe') return { ...base, kind: 'coding' }
  if (key === 'mcp.call' || key === 'mcp.tools') {
    const server = text(args?.server)
    if (key === 'mcp.call' && server && server === context.bridge) {
      const call = record(args?.arguments)
      const argv = strings(call?.command)
      // A terminal the bridge starts runs a program; a Claude Code or Codex session is coding work.
      if (args?.tool === 'session_start' && call?.agent === 'terminal' && argv?.length) {
        return { ...base, kind: 'program', ...launch(argv[0], argv.slice(1)) }
      }
      const agent = text(call?.agent)
      return { ...base, kind: 'coding', ...(agent && agent !== 'terminal' ? { program: agent } : {}) }
    }
    return { ...base, kind: 'mcp', ...(server ? { app: server } : {}) }
  }
  // `sandbox.stop` only ends work: nothing to show.
  return undefined
}
