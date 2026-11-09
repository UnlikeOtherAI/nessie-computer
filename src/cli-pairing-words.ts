/**
 * What the terminal shows while this computer is being added to a team
 * (contract §3.3, "Add this computer"): the code, how long it lasts as Nessie
 * set it, and where to enter it. No address, no fingerprint.
 */

export const ENTER_THE_CODE = 'In Nessie, open Computers, choose Add a computer and enter the code.'

/** "4821 9037". */
export const spacedCode = (code: string | undefined): string => (code ? `${code.slice(0, 4)} ${code.slice(4)}` : '')

/** "5 minutes", from the expiry Nessie gave the code; nothing when it gave none. */
export const codeLifetime = (expiresAt: string | undefined, now: Date): string => {
  const left = Date.parse(expiresAt ?? '') - now.getTime()
  if (!Number.isFinite(left)) return ''
  const minutes = Math.max(1, Math.round(left / 60_000))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

/** The two lines that show a waiting code. */
export const codeLines = (code: string | undefined, expiresAt: string | undefined, now: Date): string => {
  const lifetime = codeLifetime(expiresAt, now)
  return `Code: ${spacedCode(code)}${lifetime ? `   (${lifetime})` : ''}\n${ENTER_THE_CODE}\n`
}
