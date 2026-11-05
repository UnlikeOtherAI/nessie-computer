import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { FolderSyncVerifyReportSchema, type FolderSyncNotSyncedItem, type FolderSyncVerifyReport } from '@nessie/executor-protocol'

import { takeSnapshot } from './engine-pull.js'
import { isIgnoredName } from './ignore.js'
import { fsPath, hashFile, lstatOrNull } from './local-fs.js'
import { cleanSegment, mapTree } from './path-mapping.js'
import type { FolderSyncTransport } from './transport.js'

/**
 * `sync verify` (plan §8.6, the real-environment gate): the server snapshot as
 * the owner — the same authority sync uses — compared with every file under
 * the team folder by SHA-256. The gate is `missing` and `mismatched` empty;
 * `skipped` names each documented exclusion. A page that has no path on disk
 * is `missing`: nothing is excused without a reason code.
 */
export const verifyFolderSync = async (
  transport: FolderSyncTransport, teamDir: string,
): Promise<FolderSyncVerifyReport> => {
  const pages = await takeSnapshot(transport)
  const spaces = pages[0]!.spaces
  const all = pages.flatMap((page) => page.pages)
  const mapping = mapTree(spaces, all)
  const skipped: FolderSyncNotSyncedItem[] = pages[0]!.excludedSpaces
    .map((space) => ({ relPath: null, spaceId: space.spaceId, reason: space.reason }))
  const expected = new Map<string, string>()
  const missing: string[] = []
  let unmappable = 0
  for (const page of all) {
    if (page.kind === 'folder') continue
    const path = mapping.paths.get(page.id) ?? null
    if (page.notSyncedReason !== null) {
      skipped.push({ relPath: path, spaceId: page.spaceId, reason: page.notSyncedReason })
    } else if (path === null) {
      unmappable += 1
      missing.push(`${mapping.spaceDirs.get(page.spaceId) ?? '_'}/${cleanSegment(page.title)}`.slice(0, 900))
    } else {
      expected.set(path, page.head!.contentHash)
    }
  }

  const found = new Map<string, string>()
  const extra: string[] = []
  const walk = async (dirRel: string): Promise<void> => {
    const names = await readdir(fsPath(dirRel === '' ? teamDir : join(teamDir, ...dirRel.split('/')))).catch(() => [] as string[])
    for (const name of names.sort()) {
      const relPath = dirRel === '' ? name : `${dirRel}/${name}`
      if (isIgnoredName(name)) continue
      const item = await lstatOrNull(join(teamDir, ...relPath.split('/')))
      if (item?.type === 'link') skipped.push({ relPath, spaceId: null, reason: 'link' })
      else if (item?.type === 'directory') await walk(relPath)
      else if (item?.type === 'file') {
        if (expected.has(relPath)) found.set(relPath, await hashFile(join(teamDir, ...relPath.split('/'))))
        else extra.push(relPath)
      }
    }
  }
  await walk('')

  const mismatched: FolderSyncVerifyReport['mismatched'] = []
  for (const [relPath, hash] of expected) {
    const actual = found.get(relPath)
    if (actual === undefined) missing.push(relPath)
    else if (actual !== hash) mismatched.push({ relPath, expected: hash, actual })
  }
  return FolderSyncVerifyReportSchema.parse({
    expected: expected.size + unmappable,
    present: found.size,
    missing: missing.sort(),
    mismatched,
    extra: extra.sort(),
    skipped,
  })
}
