import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeIdIsValid } from '../../../existing-session/types.js'
import { confinedPath, digest, fileRevision } from './files.js'

export interface ClaudeHistoryEntry {
  readonly source: 'claude'
  readonly nativeId: string
  /** Exact native subagent ID, distinct from its parent's native session ID. */
  readonly agentId: string | null
  readonly historyKey: string
  readonly parentHistoryKey: string | null
  readonly revision: string
  readonly updatedAt: string
}
export interface ClaudeCatalog {
  readonly entries: readonly ClaudeHistoryEntry[]
  readonly generation: string
  readonly complete: boolean
  readonly reasons: readonly string[]
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Enumerates the supported native projects/session/subagents layout, including
 * old and empty histories. No body, labels, indexes or credential files are read.
 * All paths are local implementation details, not admitted home proof keys. */
export async function scanClaudeCatalog(root: string, recheck: () => Promise<void>): Promise<ClaudeCatalog> {
  const entries: ClaudeHistoryEntry[] = []
  const reasons = new Set<string>()
  const readDirectory = async (local?: string) => {
    await recheck()
    try {
      return await readdir(local ? await confinedPath(root, local) : root, { withFileTypes: true })
    } catch { reasons.add('directory_unavailable'); return [] }
  }
  const add = async (local: string, nativeId: string, agentId: string | null, parentHistoryKey: string | null) => {
    await recheck()
    try {
      const info = await stat(await confinedPath(root, local), { bigint: true })
      if (!info.isFile() || (process.getuid && info.uid !== BigInt(process.getuid()))) {
        reasons.add('history_unavailable'); return
      }
      entries.push({ source: 'claude', nativeId, agentId, historyKey: local.replaceAll('\\', '/'),
        parentHistoryKey, revision: fileRevision(info), updatedAt: new Date(Number(info.mtimeMs)).toISOString() })
    } catch { reasons.add('history_unavailable') }
  }
  for (const project of await readDirectory()) {
    if (project.isSymbolicLink()) { reasons.add('redirected_project'); continue }
    if (!project.isDirectory()) continue
    for (const entry of await readDirectory(project.name)) {
      if (entry.isSymbolicLink()) { reasons.add('redirected_history'); continue }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -6)
        if (nativeIdIsValid(id)) await add(join(project.name, entry.name), id, null, null)
        else reasons.add('unsupported_history_identity')
      }
      if (!entry.isDirectory() || !nativeIdIsValid(entry.name)) continue
      const children = await readDirectory(join(project.name, entry.name))
      const subagents = children.find(child => child.name === 'subagents')
      if (!subagents) continue
      if (!subagents.isDirectory() || subagents.isSymbolicLink()) { reasons.add('redirected_subagents'); continue }
      for (const child of await readDirectory(join(project.name, entry.name, 'subagents'))) {
        if (!child.name.endsWith('.jsonl')) continue
        if (!child.isFile() || child.isSymbolicLink() || !/^agent-[A-Za-z0-9_-]+\.jsonl$/u.test(child.name)) {
          reasons.add('unsupported_subagent_identity'); continue
        }
        await add(join(project.name, entry.name, 'subagents', child.name), entry.name,
          child.name.slice(6, -6), `${project.name}/${entry.name}.jsonl`)
      }
    }
  }
  await recheck()
  entries.sort((a, b) => compare(b.updatedAt, a.updatedAt) || compare(a.historyKey, b.historyKey))
  const orderedReasons = [...reasons].sort()
  return { entries, generation: digest([entries, orderedReasons]), complete: !reasons.size, reasons: orderedReasons }
}
