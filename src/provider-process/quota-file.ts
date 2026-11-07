import { open } from 'node:fs/promises'

/** Local provider-owned files are read without mutation, with a bound even if they grow during the read. */
export const readQuotaFile = async (path: string, limit: number, strict = false): Promise<string | undefined> => {
  try {
    const file = await open(path, 'r')
    try {
      const metadata = await file.stat()
      if (!metadata.isFile() || metadata.size > limit) {
        if (strict) throw new Error('Provider configuration is not readable within its size limit.')
        return undefined
      }
      const buffer = Buffer.alloc(limit + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > limit && strict) throw new Error('Provider configuration exceeds its size limit.')
      return bytesRead <= limit ? buffer.toString('utf8', 0, bytesRead) : undefined
    } finally { await file.close() }
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Provider configuration could not be read.')
    }
    return undefined
  }
}
