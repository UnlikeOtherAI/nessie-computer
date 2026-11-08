import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const revisionOf = info => digest([String(info.dev), String(info.ino), String(info.size),
  String(info.mtimeNs), String(info.ctimeNs)])

/** Synthetic resource producer for consumer tests only. Its ordinary Node
 * handles DO NOT establish Windows owner/DACL, protected native process, or
 * prospective source-owner authority. Production must not import this file. */
export async function fixtureHeldRoot(projectsRoot, recheck, options = {}) {
  const entries = []
  const reasons = []
  const walk = async (local = '') => {
    for (const entry of await readdir(join(projectsRoot, local), { withFileTypes: true })) {
      const name = local ? `${local}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) { reasons.push('redirected'); continue }
      if (entry.isDirectory()) { await walk(name); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const info = await stat(join(projectsRoot, name), { bigint: true })
      entries.push({ entryKey: `fixture:${name}`, relativeName: name, kind: 'file',
        revision: revisionOf(info), size: Number(info.size), modifiedAt: new Date(Number(info.mtimeMs)).toISOString() })
    }
  }
  await recheck()
  await walk()
  entries.sort((a, b) => a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0)
  const generation = digest([entries, reasons])
  return { source: 'claude', admittedRootKey: 'fixture:root', physicalRootKey: 'fixture:physical', generation,
    recheck,
    enumerate: async ({ cursor, limit }) => {
      await recheck()
      const offset = cursor ? Number(cursor) : 0
      const end = Math.min(entries.length, offset + limit)
      return { generation, entries: entries.slice(offset, end), nextCursor: end < entries.length ? String(end) : null,
        complete: !reasons.length && end === entries.length, reasons }
    },
    withFile: async (entryKey, revision, use) => {
      await recheck()
      options.onOpen?.()
      const entry = entries.find(row => row.entryKey === entryKey)
      if (!entry || entry.revision !== revision) throw new Error('fixture_resource_mismatch')
      const path = join(projectsRoot, entry.relativeName)
      const file = await open(path, 'r')
      try {
        const verify = async () => {
          await recheck()
          if (revisionOf(await file.stat({ bigint: true })) !== revision
            || revisionOf(await stat(path, { bigint: true })) !== revision) throw new Error('fixture_resource_changed')
        }
        await verify()
        const result = await use({ entryKey, revision, size: entry.size, recheck: verify,
          read: async (offset, length) => {
            await verify()
            if (length < 1 || length > 65536) throw new Error('fixture_read_bounds')
            const buffer = Buffer.alloc(length)
            const { bytesRead } = await file.read(buffer, 0, length, offset)
            await verify()
            return buffer.subarray(0, bytesRead)
          } })
        await verify()
        return result
      } finally { await file.close() }
    } }
}
