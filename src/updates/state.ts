import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../state-security.js'

const Preferences = z.object({
  format: z.literal(1),
  automatic: z.boolean(),
  channel: z.enum(['stable', 'preview']),
  remindedVersion: z.string().optional(),
  remindAfter: z.number().int().nonnegative().optional(),
}).strict()
const Observation = z.object({
  format: z.literal(1),
  highestSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lastCheckedAt: z.number().int().nonnegative().optional(),
  pendingEnvelope: z.string().max(200_000).optional(),
}).strict()
export type UpdateState = z.infer<typeof Preferences> & z.infer<typeof Observation>
export const defaultUpdateState = (): UpdateState => ({
  format: 1, automatic: true, channel: 'stable', highestSequence: 0,
})

/** Upgrades never replace this owner-only state directory. */
const readJson = async (directory: string, name: string): Promise<unknown> => {
  const file = join(directory, name)
  try {
    await assertOwnerOnlyStatePath(directory, 'directory')
    await assertOwnerOnlyStatePath(file, 'file')
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // An unreadable/corrupt opt-out must never silently enable installation.
    throw new Error('update.preferences_unavailable')
  }
}

export const readUpdateState = async (directory: string): Promise<UpdateState> => {
  const preferences = await readJson(directory, 'preferences.json')
  try {
    const selected: Partial<z.infer<typeof Preferences>> = preferences === undefined
      ? {} : Preferences.parse(preferences)
    const observation = await readJson(directory, `observation-${selected.channel ?? 'stable'}.json`)
    return { ...defaultUpdateState(), ...selected,
      ...(observation === undefined ? {} : Observation.parse(observation)) }
  } catch { throw new Error('update.preferences_unavailable') }
}

const writeJson = async (directory: string, name: string, value: unknown): Promise<void> => {
  await ensureOwnerOnlyStateDirectory(directory)
  const temporary = join(directory, `.updates-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
    await handle.close()
    await secureOwnerOnlyStateFile(temporary)
    await rename(temporary, join(directory, name))
  } finally {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
  }
}

/** Only an explicit local setting/reminder action writes preferences. */
export const writeUpdatePreferences = (directory: string, value: UpdateState): Promise<void> => writeJson(
  directory, 'preferences.json', Preferences.parse({ format: value.format, automatic: value.automatic,
    channel: value.channel, remindedVersion: value.remindedVersion, remindAfter: value.remindAfter }),
)

/** Catalog checks cannot overwrite an opt-out made while their download was running. */
export const writeUpdateObservation = (directory: string, value: UpdateState): Promise<void> => writeJson(
  directory, `observation-${Preferences.shape.channel.parse(value.channel)}.json`,
  Observation.parse({ format: value.format, highestSequence: value.highestSequence,
    manifestDigest: value.manifestDigest, lastCheckedAt: value.lastCheckedAt, pendingEnvelope: value.pendingEnvelope }),
)

export const updateReminderDue = (state: UpdateState, version: string, now: number): boolean =>
  state.remindedVersion !== version || (state.remindAfter ?? 0) <= now

export const remindAboutUpdateTomorrow = (state: UpdateState, version: string, now: number): UpdateState => ({
  ...state, remindedVersion: version, remindAfter: now + 86_400_000,
})
