import {
  EXECUTOR_COMMAND_CAPACITY_KINDS,
  executorCommandCapacityKind,
  type ExecutorCommandCapacity,
  type ExecutorCommandCapacityKind,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

/**
 * What a command occupies while it runs (contract §11.2,
 * `docs/sessions-and-concurrency.md`): one slot of its capacity kind, on the
 * computer and in its session, and the resources that cannot overlap. Two
 * commands that share a resource run one at a time, in arrival order;
 * everything else runs at once.
 */

export type CommandLimits = Readonly<Record<ExecutorCommandCapacityKind, number>>

export const COMPUTER_COMMAND_LIMITS: CommandLimits = { file: 16, program: 4, coding: 2, browser: 2, mcp: 8 }
export const SESSION_COMMAND_LIMITS: CommandLimits = { file: 8, program: 2, coding: 1, browser: 1, mcp: 4 }

export const freeCapacity = (
  limits: CommandLimits, used: Readonly<Partial<Record<ExecutorCommandCapacityKind, number>>>,
): ExecutorCommandCapacity => Object.fromEntries(EXECUTOR_COMMAND_CAPACITY_KINDS.map((kind) => [
  kind, Math.max(0, Math.min(64, limits[kind] - (used[kind] ?? 0))),
])) as ExecutorCommandCapacity

export const NO_CAPACITY: ExecutorCommandCapacity = { file: 0, program: 0, coding: 0, browser: 0, mcp: 0 }

const record = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** A path as the file system compares it: one separator, no `.` steps, case folded where names fold. */
const pathKey = (path: string, platform: NodeJS.Platform): string => {
  const parts = path.replace(/\\/gu, '/').split('/').filter((part) => part !== '' && part !== '.')
  const joined = parts.join('/')
  return platform === 'darwin' || platform === 'win32' ? joined.toLowerCase() : joined
}

/** The bridge tools that act on one terminal or coding session the bridge already started. */
const TERMINAL_TOOLS = new Set([
  'session_send', 'session_interrupt', 'session_steer', 'session_queue', 'session_push',
  'session_answer', 'session_user_action', 'session_close',
])

/**
 * The resources a command holds while it runs. `bridge` is the coding-sessions
 * bridge's server name, when the team has one. `sandbox.stop` holds nothing:
 * it ends the run's work and must not wait behind it.
 */
export const commandResources = (
  command: ExecutorCommandEnvelope,
  bridge: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const runId = text(command.payload.runId) ?? 'none'
  const args = record(command.payload.args)
  switch (command.operationKey) {
    case 'command.run': return [`guest:${runId}`]
    case 'browser.open': case 'browser.observe': case 'browser.act': return [`browser:${runId}`]
    case 'browser.connected.open': case 'browser.connected.observe': case 'browser.connected.act':
      return [`connected-browser:${runId}`]
    case 'coding.launch': case 'coding.observe': return [`coding:${runId}`]
    case 'file.write': {
      const path = text(args?.path)
      return path ? [`path:${runId}:${pathKey(path, platform)}`] : []
    }
    case 'workspace.review': return [`workspace:${runId}`]
    case 'workspace.promote': return [`workspace:${runId}`, 'promotion']
    case 'mcp.call': {
      if (!bridge || args?.server !== bridge || !TERMINAL_TOOLS.has(String(args.tool))) return []
      const sessionId = text(record(args.arguments)?.sessionId)
      return sessionId ? [`terminal:${sessionId}`] : []
    }
    default: return []
  }
}

/** The capacity kind of a command; `null` takes no slot (`sandbox.stop`). */
export const commandKind = (command: ExecutorCommandEnvelope): ExecutorCommandCapacityKind | null =>
  executorCommandCapacityKind(command.operationKey)
