import { SessionEffectAuthority, SessionEffectRefused } from './session-effect-authority.js'

/** The terminal subprocess is another queued effect owner, not an authority-free stdin relay. */
export const terminalEffectFrame = (value: unknown, effect?: SessionEffectAuthority, sequence?: number): string =>
  `${JSON.stringify(effect ? { value, sessionEffect: effect.reference, sequence } : value)}\n`

export const readTerminalEffectFrame = (input: unknown, required: boolean, sequence?: number) => {
  const envelope = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined
  const effect = SessionEffectAuthority.fromReference(envelope?.sessionEffect)
  if (required && (!effect || envelope?.sequence !== sequence)) throw new SessionEffectRefused()
  return { value: envelope ? envelope.value : input, effect, sequence: envelope?.sequence }
}

/** Keep the helper's own ACL context; neither marker belongs to the program it launches. */
export const terminalProgramEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.NESSIE_EXECUTOR_PACKAGED_CLI
  delete env.NESSIE_SESSION_EFFECT_REQUIRED
  return env
}

export const terminalEffectOutcome = (frame: { sequence?: unknown }, status: 'accepted' | 'uncertain'): void => {
  if (frame.sequence !== undefined) process.stdout.write(JSON.stringify({
    type: 'terminal_effect_outcome', sequence: frame.sequence, status,
  }) + '\n')
}

export class TerminalEffectOutcomes {
  #sequence = 0
  #pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  accept(value: unknown): boolean {
    const row = value as { type?: unknown; sequence?: number; status?: unknown }
    if (row?.type !== 'terminal_effect_outcome') return false
    const pending = this.#pending.get(row.sequence!)
    if (!pending) return true
    this.#pending.delete(row.sequence!)
    if (row.status === 'accepted') pending.resolve()
    else pending.reject(new SessionEffectRefused())
    return true
  }
  async send(value: unknown, effect: SessionEffectAuthority | undefined,
    write: (text: string, authority?: SessionEffectAuthority) => Promise<void>): Promise<void> {
    if (!effect) return write(terminalEffectFrame(value))
    const sequence = ++this.#sequence
    let timer: NodeJS.Timeout | undefined
    const outcome = new Promise<void>((resolve, reject) => {
      this.#pending.set(sequence, { resolve, reject })
      timer = setTimeout(() => reject(new SessionEffectRefused()), 10_000)
    })
    void outcome.catch(() => undefined)
    try { await write(terminalEffectFrame(value, effect, sequence), effect); await outcome }
    finally { clearTimeout(timer); this.#pending.delete(sequence) }
  }
}
