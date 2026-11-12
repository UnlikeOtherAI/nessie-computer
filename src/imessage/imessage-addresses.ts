import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ExecutorIMessageAddress } from '@nessie/executor-protocol'

/**
 * The addresses the Mac's iMessage account can be reached at — "You can be
 * reached for messages at" in Messages settings. macOS keeps them in the
 * `com.apple.madrid` preferences as `IMD-IDS-Aliases`: `selectedAliases` are
 * the ones switched on, `allAliases` every one the account has. Read with
 * `/usr/bin/plutil`, which needs no permission; the list is the owner's own
 * addresses and travels to their own Nessie switch, nowhere else.
 */
export const MADRID_PREFERENCES = (home = homedir()): string => join(home, 'Library', 'Preferences', 'com.apple.madrid.plist')

/** One spelling per address: `tel:`/`mailto:` dropped, an email address without case. */
export const normalizeIMessageAddress = (value: string): string => {
  const trimmed = value.trim().replace(/^(?:tel:|mailto:)/iu, '')
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/gu, '')
}

/** Phone numbers first, then email addresses, each in the order Messages lists them; no duplicates. */
export const orderedAddresses = (values: readonly string[]): ExecutorIMessageAddress[] => {
  const seen = new Set<string>()
  const addresses: ExecutorIMessageAddress[] = []
  for (const value of values) {
    const address = normalizeIMessageAddress(value)
    if (address.length < 3 || seen.has(address)) continue
    seen.add(address)
    addresses.push({ address, kind: address.includes('@') ? 'email' : 'phone' })
  }
  return [...addresses.filter((entry) => entry.kind === 'phone'), ...addresses.filter((entry) => entry.kind === 'email')]
    .slice(0, 20)
}

export type AddressReader = () => Promise<ExecutorIMessageAddress[]>

export const readIMessageAddresses = (path = MADRID_PREFERENCES()): Promise<ExecutorIMessageAddress[]> =>
  new Promise((settle) => {
    execFile('/usr/bin/plutil', ['-extract', 'IMD-IDS-Aliases', 'json', '-o', '-', path],
      { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) return settle([])
        try {
          const aliases = JSON.parse(String(stdout)) as { selectedAliases?: unknown; allAliases?: unknown }
          const list = Array.isArray(aliases.selectedAliases) && aliases.selectedAliases.length > 0
            ? aliases.selectedAliases : Array.isArray(aliases.allAliases) ? aliases.allAliases : []
          settle(orderedAddresses(list.filter((entry): entry is string => typeof entry === 'string')))
        } catch {
          settle([])
        }
      })
  })
