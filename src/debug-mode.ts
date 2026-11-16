/**
 * Debug mode: a runtime its owner started by hand against the debug control
 * plane (`docs/debug-control-plane.md`), where failures are written out in
 * full instead of being reduced to a refusal.
 *
 * It needs both variables. Every release launcher removes
 * `NESSIE_EXECUTOR_ALLOW_LOCAL_API` before it starts a runtime (the Windows app
 * and its managed launcher, the Mac app), so a team an app runs is never in
 * debug mode, and nothing in it is ever sent to a real Nessie: the same
 * variable is what limits that runtime to a loopback address.
 */
export const EXECUTOR_DEBUG_ENV = 'NESSIE_COMPUTER_DEBUG'

export const executorDebugMode = (env: NodeJS.ProcessEnv = process.env): boolean => (
  env[EXECUTOR_DEBUG_ENV] === '1' && env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1'
)

/**
 * A child the debug daemon started itself, such as the session bridge. Its
 * environment is the short list its launch spec names, so it carries the debug
 * variable alone, put there only by a daemon that is in debug mode.
 */
export const executorDebugChild = (env: NodeJS.ProcessEnv = process.env): boolean => env[EXECUTOR_DEBUG_ENV] === '1'

/** What failed, in full: for the owner's own terminal, never for a result. */
export const debugFailure = (error: unknown): string => (
  error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
)
