import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { replaceOwnerOnlyJson } from '../owner-only-json.js'

/** Local to the existing pairing. Missing on an upgraded installation means enabled. */
const pathOf = (stateDir: string): string => join(stateDir, 'existing-coding-sessions.json')

export const existingSessionsEnabled = async (stateDir: string): Promise<boolean> => {
  try {
    const value: unknown = JSON.parse(await readFile(pathOf(stateDir), 'utf8'))
    return Boolean(value && typeof value === 'object'
      && (value as { enabled?: unknown }).enabled === true)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export const setExistingSessionsEnabled = async (stateDir: string, enabled: boolean): Promise<void> => {
  await replaceOwnerOnlyJson(pathOf(stateDir), { enabled })
}
