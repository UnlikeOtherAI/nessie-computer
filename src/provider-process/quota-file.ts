import { open } from 'node:fs/promises'

/** Local provider-owned files are read without mutation, with a bound even if they grow during the read. */
export const readQuotaFile = async (path: string, limit: number): Promise<string | undefined> => {
  try {
    const file = await open(path, 'r')
    try {
      if (!(await file.stat()).isFile()) return undefined
      const buffer = Buffer.alloc(limit + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return bytesRead <= limit ? buffer.toString('utf8', 0, bytesRead) : undefined
    } finally { await file.close() }
  } catch { return undefined }
}
