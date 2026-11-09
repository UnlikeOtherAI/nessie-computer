import type { ExecutorSubscription } from '@nessie/executor-protocol'

import { runCommand, type CommandRunner } from '../coding-session/agent-env.js'
import { codexSubscription } from './cli-quota-projection.js'
import { CodexRpc } from './codex-rpc.js'

/**
 * Whether Codex is signed in: `codex login status` exits 0 only then. The
 * app-server's `account/read` can answer `account: null` for a CLI signed in
 * with ChatGPT, so it only ever names the account and its plan.
 */
export const codexSignedIn = async (
  program: string, env: NodeJS.ProcessEnv, run: CommandRunner = runCommand,
): Promise<boolean> =>
  (await run(program, ['login', 'status'], { env, timeoutMs: 10_000, maxBytes: 16 * 1024 })).code === 0

export type CodexAccountReader = {
  signedIn: (program: string, env: NodeJS.ProcessEnv) => Promise<boolean>
  rpc: (program: string, env: NodeJS.ProcessEnv) => Pick<CodexRpc, 'call' | 'close'>
}

const defaultReader: CodexAccountReader = {
  signedIn: (program, env) => codexSignedIn(program, env),
  rpc: (program, env) => new CodexRpc(program, env),
}

/** Codex's plan windows, signed in or out by its own login status, never by `account/read`. */
export const readCodexSubscription = async (
  program: string, env: NodeJS.ProcessEnv, checkedAt: string, reader: CodexAccountReader = defaultReader,
): Promise<ExecutorSubscription> => {
  if (!await reader.signedIn(program, env)) return codexSubscription({ account: null }, null, checkedAt)
  const rpc = reader.rpc(program, env)
  try {
    const account = await rpc.call('account/read', {}).catch(() => null)
    const limits = await rpc.call('account/rateLimits/read', null).catch(() => null)
    return codexSubscription(account, limits, checkedAt, { signedIn: true })
  } finally { rpc.close() }
}
