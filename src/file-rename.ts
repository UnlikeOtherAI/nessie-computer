import { rename } from 'node:fs/promises'

const WINDOWS_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const FILE_RETRY_MS = 2_000
const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

/** Keep atomic replacement while a scanner or reader briefly denies delete sharing. */
export const renameWithRetry = async (from: string, to: string): Promise<void> => {
  const deadline = Date.now() + FILE_RETRY_MS
  for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!WINDOWS_BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error
      await delay(wait)
    }
  }
}
