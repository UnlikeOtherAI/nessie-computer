import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { existingSessionId, nativeIdIsValid, objectOf, textOf, type ExistingSession } from './types.js'

export type SavedClaudeSession = { session: ExistingSession; path: string }
const PREFIX_BYTES = 32 * 1024

/** Existing summary surface. Full nested inventory and paging use NativeClaudeHistory.
 * Directory/read failure must propagate: an incomplete scan is never an empty catalog. */
export const listSavedClaudeSessions = async (profile: string): Promise<SavedClaudeSession[]> => {
  const root = await realpath(join(profile, 'projects')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw new Error('Claude saved history is unavailable.')
  })
  if (!root) return []
  const projects = await readdir(root, { withFileTypes: true })
  const saved: SavedClaudeSession[] = []
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const directory = join(root, project.name)
    if (await realpath(directory) !== directory) throw new Error('Claude saved history was redirected.')
    const files = await readdir(directory, { withFileTypes: true })
    for (const entry of files) {
      const nativeId = entry.name.endsWith('.jsonl') ? entry.name.slice(0, -6) : ''
      if (!entry.isFile() || !nativeIdIsValid(nativeId)) continue
      const path = join(directory, entry.name)
      if (await realpath(path) !== path) throw new Error('Claude saved history was redirected.')
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await file.stat()
        if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) {
          throw new Error('Claude saved history is unavailable.')
        }
        const buffer = Buffer.alloc(Math.min(info.size, PREFIX_BYTES))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
        if (info.size > buffer.length) lines.pop()
        let cwd = ''
        let title = ''
        let firstPrompt = ''
        let sidechain = false
        for (const line of lines) {
          let record: Record<string, unknown>
          try { record = objectOf(JSON.parse(line)) } catch { continue }
          if (record.sessionId !== undefined && record.sessionId !== nativeId) continue
          if (record.isSidechain === true) { sidechain = true; break }
          cwd ||= textOf(record.cwd, 4096)
          title = textOf(record.customTitle || record.aiTitle) || title
          if (record.type === 'user' && record.isMeta !== true && record.isCompactSummary !== true && !firstPrompt) {
            const content = objectOf(record.message).content
            firstPrompt = typeof content === 'string' ? textOf(content)
              : Array.isArray(content) ? textOf(content.map(objectOf).filter((part) => part.type === 'text')
                .map((part) => textOf(part.text)).join(' ')) : ''
          }
        }
        if (sidechain) continue
        saved.push({ path, session: {
          sessionId: existingSessionId('claude', profile, nativeId), nativeId, provider: 'claude',
          cwd, title: title || firstPrompt || 'Claude session', status: 'unknown',
          updatedAt: info.mtime.toISOString(), client: 'Claude Code',
          capabilities: { queue: false, push: false, steer: false, interrupt: false,
            reason: 'Saved native session. No active original-client connection is available.' },
        } })
      } finally { await file.close() }
    }
  }
  return saved.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt) || a.path.localeCompare(b.path))
}
