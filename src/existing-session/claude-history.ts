import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { objectOf, textOf, type ExistingSession } from './types.js'

/** Experimental native transcript format. Read only a bounded tail, and only on an explicit detail request. */
export const readClaudeRecentMessages = async (profile: string, session: ExistingSession) => {
  const project = session.cwd.replace(/[^A-Za-z0-9]/gu, '-')
  const path = join(profile, 'projects', project, `${session.nativeId}.jsonl`)
  const canonical = await realpath(path).catch(() => undefined)
  const root = await realpath(join(profile, 'projects')).catch(() => undefined)
  const local = root && canonical ? relative(root, canonical) : undefined
  if (!local || local.startsWith('..') || isAbsolute(local) || canonical !== join(root!, project, `${session.nativeId}.jsonl`)) {
    return { recentMessages: [], historyAvailable: false }
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
  if (!file) return { recentMessages: [], historyAvailable: false }
  try {
    const info = await file.stat()
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) {
      return { recentMessages: [], historyAvailable: false }
    }
    const length = Math.min(info.size, 128 * 1024)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, info.size - length)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (info.size > length) lines.shift()
    const messages: { role: string; text: string }[] = []
    for (const line of lines) {
      let row: Record<string, unknown>
      try { row = objectOf(JSON.parse(line)) } catch { continue }
      if (row.sessionId !== session.nativeId || (row.type !== 'user' && row.type !== 'assistant')) continue
      const message = objectOf(row.message)
      const content = message.content
      const text = typeof content === 'string' ? textOf(content, 4_000)
        : Array.isArray(content) ? content.map(objectOf).filter((part) => part.type === 'text')
          .map((part) => textOf(part.text, 4_000)).join('\n').slice(0, 4_000) : ''
      if (text) messages.push({ role: row.type, text })
    }
    return { recentMessages: messages.slice(-4), historyAvailable: true }
  } finally { await file.close() }
}
