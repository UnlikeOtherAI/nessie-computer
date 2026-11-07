import { isAbsolute } from 'node:path'

import { executorChildCommand } from '../executor-child-command.js'
import { resolveExecutorEntry } from './host-spawn.js'
import { SESSION_SECRET_SERVER_NAME } from './session-secret-mcp.js'
import type { CodingSessionPaths } from './session-files.js'

/**
 * A development run loads TypeScript through `--import tsx`, which Node
 * resolves from the working directory — the agent's folder, for a server the
 * agent starts — so a bare loader name is resolved here, where it is found.
 */
const loaderArguments = (execArgv: readonly string[]): string[] => execArgv.map((argument, index) => {
  if (execArgv[index - 1] !== '--import' || argument.startsWith('file:') || isAbsolute(argument)) return argument
  try { return import.meta.resolve(argument) } catch { return argument }
})

/** How a coding agent starts the session's `request_secret` server: this executor, as the host runs it. */
export type SessionSecretServer = { name: string; command: string; args: string[] }

export const sessionSecretServer = (
  paths: CodingSessionPaths, entry: string = resolveExecutorEntry(),
): SessionSecretServer => {
  const [command, ...args] = executorChildCommand({
    execPath: process.execPath, execArgv: loaderArguments(process.execArgv), entry,
    packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  }, ['serve-session-secrets', '--session-dir', paths.dir])
  return { name: SESSION_SECRET_SERVER_NAME, command: command!, args }
}
