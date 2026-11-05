import { approveExecutorPairingOrigin, EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN } from '@nessie/executor-protocol'

/**
 * The one plain-HTTP origin a development executor may pair with: this
 * worktree's own API, on the port `NESSIE_API_PORT` names (the same variable
 * `scripts/dev-ports.mjs` resolves), else the default. Every CLI path reads it
 * from here, so a worktree on its own port pair pairs the same way on each.
 */
export const localDevelopmentApiOrigin = (): string => {
  const configuredPort = process.env.NESSIE_API_PORT?.trim()
  if (configuredPort === undefined || configuredPort === '') return EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN
  const port = Number(configuredPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`NESSIE_API_PORT must be a port number between 1 and 65535, got "${configuredPort}"`)
  }
  return `http://127.0.0.1:${port}`
}

/**
 * Which Nessie this executor is being paired with. `nessie` and `deeptest`
 * resolve to their pinned origins so the common cases cannot be typo-squatted;
 * anything else is somebody's own server, which Nessie being open source makes
 * an ordinary case rather than an exception. The rule itself lives in
 * `@nessie/executor-protocol` so the CLI, the Mac app and the Windows tray cannot drift
 * into three readings of it.
 */
export const secureApiUrl = (value: string): string => {
  const verdict = approveExecutorPairingOrigin(value, {
    allowLocalDevelopment: process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1',
    localDevelopmentOrigin: localDevelopmentApiOrigin(),
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  return verdict.origin
}
