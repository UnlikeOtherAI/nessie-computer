import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { LocalCliEngineSchema, type LocalCliEngine } from '@nessie/executor-protocol'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

/**
 * A team's Make available switches (contract §12), in its state folder. On by
 * default (Ondrej's ruling, 8 Nov): an installed, signed-in CLI is offered to
 * every team, new or existing, until its owner turns it off. Only an explicit
 * off is stored, so it survives updates and a new account starts on. The
 * running daemon watches this file and applies a change live; it writes back
 * what Nessie answered.
 */
export type LocalCliEngineKey = { engine: LocalCliEngine; profileId: string | null }

const SETTINGS = 'local-cli-engines.json'
const STATUS = 'local-cli-engines-status.json'
const MAX_KEYS = 34

export const localCliEngineKey = (key: LocalCliEngineKey): string =>
  key.profileId === null ? key.engine : `${key.engine}:${key.profileId}`

const KeySchema = z.string().regex(/^(?:claude-code|codex)(?::[0-9a-f-]{36})?$/u)
export const parseLocalCliEngineKey = (value: string): LocalCliEngineKey => {
  const parsed = KeySchema.parse(value)
  const [engine, profileId] = parsed.split(/:(.*)/su)
  return {
    engine: LocalCliEngineSchema.parse(engine),
    profileId: profileId ? z.string().uuid().parse(profileId) : null,
  }
}

const Settings = z.object({ version: z.literal(1), off: z.array(KeySchema).max(MAX_KEYS) }).strict()
/** `yes` Nessie has the host; `not_yet` registration was refused as unknown (an older Nessie) or failed. */
const Status = z.object({
  version: z.literal(1), checkedAt: z.string().datetime(),
  offered: z.record(KeySchema, z.enum(['yes', 'not_yet'])),
}).strict()
export type LocalCliEngineStatus = z.infer<typeof Status>

const readOwnerJson = async <T>(stateDir: string, name: string, schema: z.ZodType<T>): Promise<T | null> => {
  const path = join(stateDir, name)
  try { await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.length > 64 * 1024) throw new Error('local_cli_engines_invalid')
  return schema.parse(JSON.parse(bytes.toString('utf8')))
}

/** The engine connections the owner switched off for this team; every other one is on. */
export const readLocalCliSwitchedOff = async (stateDir: string): Promise<Set<string>> =>
  new Set((await readOwnerJson(stateDir, SETTINGS, Settings))?.off ?? [])

/** Turns one engine connection on or off for this team; answers whether anything changed. */
export const setLocalCliAvailability = async (
  stateDir: string, key: LocalCliEngineKey, available: boolean,
): Promise<boolean> => {
  await assertOwnerOnlyStatePath(stateDir, 'directory')
  const lease = await acquireOwnerStateLock(stateDir, 'local-cli-engines.lock')
  try {
    const off = await readLocalCliSwitchedOff(stateDir)
    const name = localCliEngineKey(key)
    if (off.has(name) !== available) return false
    if (available) off.delete(name)
    else off.add(name)
    await replaceOwnerOnlyJson(join(stateDir, SETTINGS), Settings.parse({ version: 1, off: [...off].sort() }))
    return true
  } finally { await lease.release() }
}

/** Drops a removed account's switch from this team. */
export const forgetLocalCliProfile = async (stateDir: string, profileId: string): Promise<void> => {
  for (const engine of LocalCliEngineSchema.options) {
    await setLocalCliAvailability(stateDir, { engine, profileId }, true)
  }
}

export const readLocalCliStatus = (stateDir: string): Promise<LocalCliEngineStatus | null> =>
  readOwnerJson(stateDir, STATUS, Status)

export const writeLocalCliStatus = (
  stateDir: string, offered: Record<string, 'yes' | 'not_yet'>, now: Date = new Date(),
): Promise<void> => replaceOwnerOnlyJson(join(stateDir, STATUS),
  Status.parse({ version: 1, checkedAt: now.toISOString(), offered }))

export const LOCAL_CLI_SETTINGS_FILE = SETTINGS
