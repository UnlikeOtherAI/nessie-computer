/**
 * Names the folder sync never picks up from disk (plan §2.3): operating-system
 * litter, editor and download temporaries, our own marker, hidden names, and
 * the copies R1 keeps beside a read-only file — those are the person's edit,
 * kept on disk on purpose and never uploaded.
 *
 * Links (symlinks, junctions, reparse points) are a type, not a name: the
 * scanner reports them as `link` from `lstat` and they are never followed or
 * synced (C17). Hard links are ordinary files.
 */

const EXACT_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

const PATTERNS: readonly RegExp[] = [
  /^~\$/u, // Office lock files
  /\.(?:tmp|temp|part|crdownload|swp|swo)$/iu,
  /^#.*#$/u, // Emacs autosaves
  // Hidden names, which also covers `.nessie-sync*`, LibreOffice's
  // `.~lock.*#`, Emacs's `.#*` and vim's `.*.sw?`.
  /^\./u,
]

/**
 * The marker R1 puts in a kept local edit's name. `quarantineCopyName` builds
 * it; recognising it here keeps the copy out of every later upload.
 */
export const QUARANTINE_MARKER = ' (your edit – not synced – '

const QUARANTINE_NAME = /\(your edit – not synced – \d{4}-\d{2}-\d{2} \d{4}\)(?: \(\d+\))?(?:\.[^.]*)?$/u

/** True when a file or directory of this name is never synced. */
export const isIgnoredName = (name: string): boolean => {
  if (EXACT_NAMES.has(name.toLowerCase())) return true
  if (PATTERNS.some((pattern) => pattern.test(name))) return true
  return name.includes(QUARANTINE_MARKER) && QUARANTINE_NAME.test(name)
}

/** True when any segment of a relative path is ignored: nothing below an ignored directory syncs. */
export const isIgnoredPath = (relPath: string): boolean => relPath.split('/').some(isIgnoredName)

/**
 * True while an editor still holds a file (amendment A9): a lock or temporary
 * sibling of its name exists — Office's `~$name` (Word drops up to two leading
 * characters of a long name), LibreOffice's `.~lock.name#`, `name.tmp` or
 * `stem.tmp`, macOS safe-save `name.sb-*` — or it is a SQLite database whose
 * `-wal`, `-shm` or `-journal` sidecar is present (the group is one unit).
 * `siblings` are the other names in the same directory, lower-cased. Package
 * directories (`.pages`, `.numbers`, `.sketch`) are ordinary folders.
 */
export const heldByEditor = (name: string, siblings: ReadonlySet<string>): boolean => {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const stem = dot > 0 ? lower.slice(0, dot) : lower
  const exact = [
    `~$${lower}`, `~$${lower.slice(1)}`, `~$${lower.slice(2)}`,
    `.~lock.${lower}#`, `${lower}.tmp`, `${stem}.tmp`,
    `${lower}-wal`, `${lower}-shm`, `${lower}-journal`,
  ]
  if (exact.some((candidate) => candidate !== lower && siblings.has(candidate))) return true
  for (const sibling of siblings) {
    if (sibling.startsWith(`${lower}.sb-`)) return true
  }
  return false
}
