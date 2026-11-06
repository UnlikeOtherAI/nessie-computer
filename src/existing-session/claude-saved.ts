import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { existingSessionId, nativeIdIsValid, objectOf, textOf, type ExistingSession } from './types.js'

export type SavedClaudeSession = { session: ExistingSession; path: string }
const MAX_SESSIONS = 5_000
const PREFIX_BYTES = 32 * 1024
const RECENT_MS = 30 * 24 * 60 * 60 * 1000

/** T3-compatible recent native history discovery, without reading credential files or subagent transcripts. */
export const listSavedClaudeSessions = async (profile: string, now = Date.now()): Promise<SavedClaudeSession[]> => {
  const root = await realpath(join(profile, 'projects')).catch(() => undefined)
  if (!root) return []
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const saved: SavedClaudeSession[] = []
  let inspected = 0
  for (const project of projects.filter((entry) => entry.isDirectory()).slice(0, 1_000)) {
    const directory = join(root, project.name)
    if (await realpath(directory).catch(() => undefined) !== directory) continue
    const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of files) {
      if (++inspected > MAX_SESSIONS * 4) return saved
      const nativeId = entry.name.endsWith('.jsonl') ? entry.name.slice(0, -6) : ''
      if (!entry.isFile() || !nativeIdIsValid(nativeId)) continue
      const path = join(directory, entry.name)
      if (await realpath(path).catch(() => undefined) !== path) continue
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
      if (!file) continue
      try {
        const info = await file.stat()
        if (!info.isFile() || info.mtimeMs < now - RECENT_MS
          || (process.getuid && info.uid !== process.getuid())) continue
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
        if (sidechain || !cwd) continue
        saved.push({ path, session: {
          sessionId: existingSessionId('claude', profile, nativeId), nativeId, provider: 'claude',
          cwd, title: title || firstPrompt || 'Claude session', status: 'unknown',
          updatedAt: info.mtime.toISOString(), client: 'Claude Code',
          capabilities: { queue: false, push: false, steer: false, interrupt: false,
            reason: 'Saved native session. No active original-client connection is available.' },
        } })
      } finally { await file.close() }
      if (saved.length >= MAX_SESSIONS) return saved
    }
  }
  return saved.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
}
