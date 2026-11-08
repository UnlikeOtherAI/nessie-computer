import { SessionEffectAuthority, SessionEffectRefused } from './session-effect-authority.js'

/** The terminal subprocess is another queued effect owner, not an authority-free stdin relay. */
export const terminalEffectFrame = (value: unknown, effect?: SessionEffectAuthority): string =>
  `${JSON.stringify(effect ? { value, sessionEffect: effect.reference } : value)}\n`

export const readTerminalEffectFrame = (input: unknown, required: boolean) => {
  const envelope = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined
  const effect = SessionEffectAuthority.fromReference(envelope?.sessionEffect)
  if (required && !effect) throw new SessionEffectRefused()
  return { value: envelope ? envelope.value : input, effect }
}

/** Keep the helper's own ACL context; neither marker belongs to the program it launches. */
export const terminalProgramEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.NESSIE_EXECUTOR_PACKAGED_CLI
  delete env.NESSIE_SESSION_EFFECT_REQUIRED
  return env
}
