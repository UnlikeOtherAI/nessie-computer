/**
 * The built-in programs a team may start without the owner naming them: the
 * "Programs" defaults a new pairing writes (contract §4.3).
 *
 * Three are named programs — Claude Code (`claude`), Codex (`codex`) and
 * T3 Code (`t3`) — and they are matched by name exactly as an owner's own
 * `claude *` rule would be: the session finds the name through the person's
 * PATH when it starts. The fourth, "Apps from UnlikeOtherAI", is never a name.
 * It admits an executable only when its verified code signature names
 * UnlikeOtherAI as the publisher (`program-trust-signature.ts`), so a file
 * called `kelpie` that anybody could have written counts for nothing.
 *
 * These are machine-owned rules like the rest of `LocalCommandPolicy`: they
 * never enter a descriptor or a server response.
 */
export type ProgramTrust = {
  /** Programs whose verified code signature names UnlikeOtherAI (macOS and Windows). */
  unlikeotherai: boolean
  /** Claude Code's `claude`. */
  claudeCode: boolean
  /** OpenAI Codex's `codex`. */
  codex: boolean
  /** T3 Code's `t3` command. */
  t3Code: boolean
}

export type ProgramTrustKey = keyof ProgramTrust

export const PROGRAM_TRUST_KEYS = ['claudeCode', 'codex', 't3Code', 'unlikeotherai'] as const satisfies
  readonly ProgramTrustKey[]

/** Every built-in entry on, which is what a new pairing writes. */
export const allProgramTrust = (): ProgramTrust => ({ unlikeotherai: true, claudeCode: true, codex: true, t3Code: true })

/**
 * The command each named built-in starts. T3 Code's desktop app writes a
 * `t3` command (`~/.t3/bin/t3` on macOS, which runs the app's bundled CLI)
 * and its npm package installs the same name; neither is a stable path, so
 * the name is the rule, as it is for the other two.
 */
export const TRUSTED_PROGRAM_NAMES = {
  claudeCode: 'claude',
  codex: 'codex',
  t3Code: 't3',
} as const satisfies Record<Exclude<ProgramTrustKey, 'unlikeotherai'>, string>

/** The platforms on which a publisher's code signature can be verified. */
export const programTrustSignatureCovers = (platform: NodeJS.Platform): boolean => (
  platform === 'darwin' || platform === 'win32'
)

/**
 * One built-in entry as `describe` reports it, for the app to draw its
 * Programs list from. `available` is false where the entry can never admit
 * anything on this computer: "Apps from UnlikeOtherAI" on Linux, which has no
 * verifiable signature on an ordinary executable.
 */
export type ProgramDefault = {
  id: ProgramTrustKey
  verifiedBy: 'name' | 'signature'
  /** The command name, for the three named programs. */
  program?: string
  available: boolean
}

export const programDefaults = (platform: NodeJS.Platform = process.platform): ProgramDefault[] => [
  { id: 'unlikeotherai', verifiedBy: 'signature', available: programTrustSignatureCovers(platform) },
  ...(['claudeCode', 'codex', 't3Code'] as const).map((id): ProgramDefault => ({
    id, verifiedBy: 'name', program: TRUSTED_PROGRAM_NAMES[id], available: true,
  })),
]

/** Exactly the four boolean keys, or a refusal: a partial or misspelt entry is not a policy. */
export const parseProgramTrust = (value: unknown): ProgramTrust => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local command policy.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== [...PROGRAM_TRUST_KEYS].sort().join(',')
    || PROGRAM_TRUST_KEYS.some((key) => typeof input[key] !== 'boolean')) {
    throw new Error('Invalid local command policy.')
  }
  return {
    unlikeotherai: input.unlikeotherai as boolean,
    claudeCode: input.claudeCode as boolean,
    codex: input.codex as boolean,
    t3Code: input.t3Code as boolean,
  }
}

/**
 * Whether a trusted built-in names this program. `name` is already in the
 * form a rule compares with (the file name, folded and without `.exe` where
 * the OS does that), so `Claude.exe` on Windows is `claude` here.
 */
export const trustedProgramNamed = (trust: ProgramTrust | undefined, name: string): boolean => (
  Boolean(trust) && (['claudeCode', 'codex', 't3Code'] as const)
    .some((key) => trust![key] && TRUSTED_PROGRAM_NAMES[key] === name)
)
