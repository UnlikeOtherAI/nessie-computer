import { watch, type FSWatcher } from 'node:fs'
import { sep } from 'node:path'

import { parentPath } from './path-mapping.js'

/**
 * Local change hints (plan §2.7). `fs.watch` with `recursive` on Windows and
 * macOS; an event only *schedules* a scan of the touched subtree — the scan
 * decides. Watchers drop events, so nothing depends on them: a full reconcile
 * runs every ten minutes and after start, resume, a watcher error or an
 * overflow, and Linux runs on that alone. A watcher error asks for a full
 * rescan and the watcher is re-armed on the next start.
 */

/** Past this many touched directories in one burst, scan everything instead. */
const OVERFLOW_PATHS = 200
const SETTLE_MS = 250

/** What to rescan (null: everything); `error` says the watcher stopped and must be armed again. */
export type ChangeHint = { scope: string[] | null; error?: true }

export type FolderSyncWatcher = { close(): void }

export const watcherSupported = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' || platform === 'darwin'

/**
 * Watch `teamDir`; `onChange` receives the team-relative directories to rescan
 * (each event's parent, so a rename's other half is in scope), or null for
 * everything.
 */
export const watchTeamFolder = (
  teamDir: string,
  onChange: (hint: ChangeHint) => void,
  options: { platform?: NodeJS.Platform; watchImpl?: typeof watch } = {},
): FolderSyncWatcher => {
  if (!watcherSupported(options.platform)) return { close: () => undefined }
  const paths = new Set<string>()
  let overflow = false
  let timer: NodeJS.Timeout | null = null
  let closed = false
  const flush = () => {
    timer = null
    if (closed) return
    const scope = overflow ? null : [...paths]
    paths.clear()
    overflow = false
    onChange({ scope })
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, SETTLE_MS)
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = (options.watchImpl ?? watch)(teamDir, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename === null || filename === undefined) overflow = true
      else {
        const relPath = String(filename).split(sep).join('/')
        paths.add(parentPath(relPath) || relPath)
        if (paths.size > OVERFLOW_PATHS) overflow = true
      }
      schedule()
    })
    watcher.on('error', () => {
      watcher?.close()
      if (!closed) onChange({ scope: null, error: true })
    })
  } catch {
    // The team folder is gone or cannot be watched: the periodic reconcile covers it.
    queueMicrotask(() => onChange({ scope: null, error: true }))
  }
  return {
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
    },
  }
}
