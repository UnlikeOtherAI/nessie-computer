import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { createJsonExclusive, readJsonPatiently, writeJsonAtomic } from '../coding-session/session-files.js'
import { existingAuthorityIsLive } from './authority.js'
import { channelInboxDir, type ChannelEvent } from './channel-files.js'
import { existingSessionsEnabled } from './settings.js'

const claim = async (path: string): Promise<string | undefined> => {
  const claimed = path.replace(/\.pending$/u, '.claimed')
  // Concurrent Windows renames may both succeed. CREATE_NEW / O_EXCL has one winner.
  if (!await createJsonExclusive(claimed, { claimedAt: Date.now() })) return undefined
  try { await unlink(path); return claimed }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await unlink(claimed)
      return undefined
    }
    throw error
  }
}

/** Expired input cannot occupy the queue forever when its channel has stopped. */
export const pendingClaudeEvents = async (inbox: string): Promise<number> => {
  const files = (await readdir(inbox)).filter((name) => /^[a-f0-9-]+\.pending$/u.test(name))
  let pending = 0
  for (const name of files) {
    const path = join(inbox, name)
    const event = await readJsonPatiently<ChannelEvent>(path)
    if (event && event.expiresAt > Date.now()) { pending += 1; continue }
    const claimed = await claim(path)
    if (!claimed) { await unlink(path).catch(() => undefined); continue }
    if (event) await writeJsonAtomic(path.replace(/\.pending$/u, '.result'), {
      state: 'cancelled', providerMessageId: event.commandId,
    })
    await unlink(claimed)
  }
  return pending
}

/** Claim each event before provider I/O; a failed write stays claimed and is never automatically replayed. */
export const drainClaudeChannel = async (input: {
  stateDir: string
  sessionId: string
  incarnation: string
  notify: (event: ChannelEvent) => Promise<void>
}): Promise<void> => {
  const inbox = channelInboxDir(input.stateDir, input.sessionId)
  const files = (await readdir(inbox)).filter((name) => /^[a-f0-9-]+\.pending$/u.test(name)).sort().slice(0, 32)
  const events = await Promise.all(files.map(async (name) => ({
    path: join(inbox, name), event: await readJsonPatiently<ChannelEvent>(join(inbox, name)),
  })))
  events.sort((left, right) => (left.event?.queuedAt ?? 0) - (right.event?.queuedAt ?? 0))
  for (const { path, event } of events) {
    if (!event) { await unlink(path).catch(() => undefined); continue }
    const resultPath = path.replace(/\.pending$/u, '.result')
    const claimed = await claim(path)
    if (!claimed) continue
    const enabled = await existingSessionsEnabled(input.stateDir) && await existingAuthorityIsLive(input.stateDir)
    const valid = enabled && event.sessionId === input.sessionId && event.incarnation === input.incarnation
      && event.expiresAt > Date.now() && typeof event.message === 'string' && event.message.length <= 33_000
    if (!valid) {
      await writeJsonAtomic(resultPath, { state: 'cancelled', providerMessageId: event.commandId })
      await unlink(claimed)
      continue
    }
    await input.notify(event)
    await writeJsonAtomic(resultPath, { state: 'written_to_transport', providerMessageId: event.commandId,
      behavior: 'Claude received an MCP channel notification; consumption is not acknowledged.' })
    await unlink(claimed)
  }
}
