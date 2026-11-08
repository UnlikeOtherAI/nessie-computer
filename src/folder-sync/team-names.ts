import type { FolderSyncHandshakeResponse } from '@nessie/executor-protocol'

import type { TeamFolderNames } from './team-folder.js'
import type { FolderSyncTransport } from './transport.js'

/**
 * The names a team folder is made of, and where the engine gets them. The
 * handshake names the team, and the organisation when Nessie sends it; the
 * pairing claim names both. The engine keeps the last ones it learned in
 * `status.json` (`teamLabel`, `organizationName`), so `sync status` can say
 * where files will go before the folder is named.
 */

export type KnownTeamNames = { teamLabel: string | null; organizationName: string | null }

const ASK_EVERY_MS = 60 * 60 * 1000

export class TeamNames {
  private askedAt = Number.NEGATIVE_INFINITY

  constructor(private readonly transport: FolderSyncTransport, private readonly now: () => number) {}

  /**
   * The names a new team folder takes: the handshake's team label and, when
   * Nessie did not send the organisation's name, the one its claim gives now.
   * A failed read throws, so the pass is retried rather than a folder named
   * from a guess.
   */
  async forNewFolder(handshake: FolderSyncHandshakeResponse): Promise<TeamFolderNames> {
    const organizationName = handshake.organizationName ?? (await this.transport.teamNames()).organizationName
    return { teamName: handshake.teamLabel, organizationName }
  }

  /**
   * Before the folder is named: read the claim once per daemon start, so a
   * renamed team shows its new name, and again each hour while a name is
   * still unknown. Answers the names to keep, or null when nothing was
   * learned; a failed read is quiet — it only delays the preview, never sync.
   */
  async learn(known: KnownTeamNames): Promise<KnownTeamNames | null> {
    const complete = Boolean(known.teamLabel && known.organizationName)
    const asked = this.askedAt !== Number.NEGATIVE_INFINITY
    if ((complete && asked) || this.now() - this.askedAt < ASK_EVERY_MS) return null
    this.askedAt = this.now()
    try {
      const names = await this.transport.teamNames()
      return { teamLabel: names.teamName ?? known.teamLabel, organizationName: names.organizationName }
    } catch {
      return null
    }
  }
}
