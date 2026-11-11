import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson } from '../owner-only-json.js'

/**
 * Where delivery stands, in the team's owner-only state folder: the switch's
 * `since` it was started for and the last `chat.db` row handed to Nessie.
 * Row ids are this Mac's own, so the cursor never leaves it. A new `since`
 * (the owner switched it off and on again) starts over from the newest row.
 */
export type IMessageCursor = { since: string; rowId: number }

export const imessageCursorPath = (stateDir: string): string => join(stateDir, 'imessage.json')

export const loadIMessageCursor = async (stateDir: string): Promise<IMessageCursor | null> => {
  try {
    const value = JSON.parse(await readFile(imessageCursorPath(stateDir), 'utf8')) as Partial<IMessageCursor>
    return typeof value.since === 'string' && Number.isSafeInteger(value.rowId) && (value.rowId ?? -1) >= 0
      ? { since: value.since, rowId: value.rowId as number } : null
  } catch {
    return null
  }
}

export const saveIMessageCursor = (stateDir: string, cursor: IMessageCursor): Promise<void> =>
  replaceOwnerOnlyJson(imessageCursorPath(stateDir), cursor)
