import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../state-security.js'

const State = z.object({
  format: z.literal(1),
  automatic: z.boolean(),
  channel: z.enum(['stable', 'preview']),
  highestSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lastCheckedAt: z.number().int().nonnegative().optional(),
  remindedVersion: z.string().optional(),
  remindAfter: z.number().int().nonnegative().optional(),
  pendingEnvelope: z.string().max(200_000).optional(),
}).strict()
export type UpdateState = z.infer<typeof State>
export const defaultUpdateState = (): UpdateState => ({
  format: 1, automatic: true, channel: 'stable', highestSequence: 0,
})

/** Upgrades never replace this owner-only state directory. */
export const readUpdateState = async (directory: string): Promise<UpdateState> => {
  const file = join(directory, 'updates.json')
  try {
    await assertOwnerOnlyStatePath(directory, 'directory')
    await assertOwnerOnlyStatePath(file, 'file')
    return State.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultUpdateState()
    // An unreadable/corrupt opt-out must never silently enable installation.
    throw new Error('update.preferences_unavailable')
  }
}

/** The caller holds the installation's update process lease through this write. */
export const writeUpdateState = async (directory: string, value: UpdateState): Promise<void> => {
  await ensureOwnerOnlyStateDirectory(directory)
  const temporary = join(directory, `.updates-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(State.parse(value))}\n`)
    await handle.sync()
    await handle.close()
    await secureOwnerOnlyStateFile(temporary)
    await rename(temporary, join(directory, 'updates.json'))
  } finally {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
  }
}

export const updateReminderDue = (state: UpdateState, version: string, now: number): boolean =>
  state.remindedVersion !== version || (state.remindAfter ?? 0) <= now

export const remindAboutUpdateTomorrow = (state: UpdateState, version: string, now: number): UpdateState => ({
  ...state, remindedVersion: version, remindAfter: now + 86_400_000,
})
