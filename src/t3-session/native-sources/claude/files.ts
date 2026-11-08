import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, toNamespacedPath } from 'node:path'

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const samePath = (a: string, b: string): boolean => toNamespacedPath(a) === toNamespacedPath(b)
export const fileRevision = (info: BigIntStats): string => digest([
  String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs),
])

/** Physical confinement only. The caller must already hold canonical read
 * admission. This function neither reads credentials nor creates authority. */
export async function confinedPath(root: string, local: string): Promise<string> {
  if (!local || isAbsolute(local) || local.split(/[\\/]/u).some(part => !part || part === '.' || part === '..')) {
    throw new Error('claude_history_path_invalid')
  }
  const filename = resolve(root, local)
  const inside = relative(root, filename)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('claude_history_path_invalid')
  }
  let current = root
  for (const part of inside.split(sep)) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink() || !samePath(await realpath(current), current)) {
      throw new Error('claude_history_redirected')
    }
  }
  return filename
}

export async function withClaudeFile<A>(root: string, local: string, expectedRevision: string | undefined,
  recheck: () => Promise<void>, use: (file: FileHandle, size: number, revision: string) => Promise<A>): Promise<A> {
  await recheck()
  const filename = await confinedPath(root, local)
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat({ bigint: true })
    const revision = fileRevision(info)
    if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (process.getuid && info.uid !== BigInt(process.getuid()))
      || (expectedRevision !== undefined && revision !== expectedRevision)) {
      throw new Error('claude_history_changed_or_unavailable')
    }
    const verify = async () => {
      await recheck()
      await confinedPath(root, local)
      if (fileRevision(await file.stat({ bigint: true })) !== revision
        || fileRevision(await stat(filename, { bigint: true })) !== revision) {
        throw new Error('claude_history_changed_or_unavailable')
      }
    }
    await verify()
    const result = await use(file, Number(info.size), revision)
    await verify()
    return result
  } finally { await file.close() }
}
