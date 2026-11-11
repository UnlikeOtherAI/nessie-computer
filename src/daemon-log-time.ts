/**
 * Every line a team's daemon writes starts with when it was written. The apps
 * append these lines to the team's log file as they arrive; without a time, a
 * refusal from last week and one from a minute ago read the same.
 */
export const stampDaemonLog = (now: () => Date = () => new Date()): void => {
  for (const level of ['error', 'warn'] as const) {
    const write = console[level].bind(console)
    console[level] = (...parts: unknown[]) => write(now().toISOString(), ...parts)
  }
}
