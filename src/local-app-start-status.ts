import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { EXECUTOR_MCP_SERVER_MAXIMUM, ExecutorMcpUnavailableReasonSchema } from '@nessie/executor-protocol'

import type { LocalAppStartFailure } from './mcp-start-backoff.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

/**
 * Which of a team's local apps keep failing to start, as its running daemon
 * last saw them (`mcp-start-backoff.ts`): `local-apps-status.json` in the
 * team's folder, owner-only, which `describe` reads into each local app's
 * `start`. The daemon writes it on every change and empties it when it starts
 * and stops, so a stopped team shows no stale failure. It names a local app,
 * a count, a reason and a time — never a launch spec.
 */

const FILE = 'local-apps-status.json'

const Failure = z.object({
  name: z.string().min(1).max(200),
  failures: z.number().int().positive(),
  reason: ExecutorMcpUnavailableReasonSchema,
  retryAt: z.string().datetime().optional(),
}).strict()

const Status = z.object({
  version: z.literal(1),
  apps: z.array(Failure).max(EXECUTOR_MCP_SERVER_MAXIMUM + 1),
}).strict()

/** A local app's start state in `describe`: absent while it starts. */
export type LocalAppStartState = Omit<LocalAppStartFailure, 'name'>

/**
 * The daemon's writer: each save waits for the one before it, so the file
 * always ends at the latest list. A save that fails is logged, never thrown:
 * the status is for a person reading `describe`, not a gate.
 */
export const createLocalAppStartStatusWriter = (
  stateDir: string, log: (message: string) => void = (message) => { console.error(`[nessie-executor] ${message}`) },
) => {
  let last: Promise<void> = Promise.resolve()
  return (apps: readonly LocalAppStartFailure[]): Promise<void> => {
    last = last.then(() => replaceOwnerOnlyJson(join(stateDir, FILE), Status.parse({ version: 1, apps })))
      .catch((error: unknown) => {
        log(`local app status was not saved: ${(error as NodeJS.ErrnoException).code ?? 'unknown failure'}`)
      })
    return last
  }
}

/** Each failing local app's start state, by name; empty when there is no status. */
export const readLocalAppStartStatus = async (stateDir: string): Promise<Map<string, LocalAppStartState>> => {
  const path = join(stateDir, FILE)
  try { await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.length > 64 * 1024) return new Map()
  let document: unknown
  try { document = JSON.parse(bytes.toString('utf8')) } catch { return new Map() }
  // A damaged status reads as none: it reports, it never decides.
  const parsed = Status.safeParse(document)
  if (!parsed.success) return new Map()
  return new Map(parsed.data.apps.map(({ name, ...state }) => [name, state]))
}
