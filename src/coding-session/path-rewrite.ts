import { createIdentityRewrite, NO_HOST_IDENTITY, type HostIdentity } from './host-identity.js'
import { ACCOUNT_PLACEHOLDER, SECRET_PLACEHOLDER } from './projection.js'

/**
 * Every host path a coding agent prints, rewritten before it leaves the host.
 *
 * A path under a configured root becomes `<root>/relative`; any other absolute
 * path (home, `~/.claude`, temp, the executor's own state) becomes
 * `<host path>`. Coding agents spell one directory many ways — `C:\Users\…`,
 * `C:/Users/…`, `c:\users\…`, `\\?\C:\…`, Git Bash's `/c/Users/…`, and
 * JSON-escaped `C:\\Users\\…` — so each root is matched as a pattern over its
 * segments rather than as one literal string.
 *
 * The generic patterns deliberately match only absolute paths under the
 * directories hosts actually keep files in. An API route like `/api/runs/:id`
 * in an agent's summary is content the supervisor needs, not a host path.
 *
 * A directory name may hold spaces (`C:\Program Files\Git`, `C:\Users\Other
 * Person\…`): a space-separated word that a separator follows is part of the
 * path, so no tail of another account's name is left in plain text. A spaced
 * last component cannot be told from prose that way; the roots module names
 * the neighbouring profile directories outright for that case.
 *
 * Paths first, then the OS user and host names (`host-identity.ts`), which
 * therefore never break a path apart before its rule has seen it whole.
 * `rewritePaths` is the path rules alone, for a value that is not prose — an
 * identifier other code parses, a pull request's URL — which a name that
 * happens to spell it would otherwise break. `rewriteBranch` rewrites a name
 * in every segment, for a git branch (`feature/ondre/fix`), which is a name and
 * never a relative path the model has to resolve.
 */

export const HOST_PATH_PLACEHOLDER = '<host path>'

/** A root's names for itself: the declared path and its canonical realpath. */
export type PathRewriteRoot = {
  /** `undefined` rewrites to `<host path>` (home, temp, the state directory). */
  name: string | undefined
  paths: string[]
}

export type PathRewriter = {
  /** Paths, then the OS user and host names: for text. */
  rewrite: (text: string) => string
  /** Paths only. */
  rewritePaths: (text: string) => string
  /** Paths, then the names wherever they stand, whole segments included: for a branch. */
  rewriteBranch: (text: string) => string
}

const SEP = '[\\\\/]+'
const SEGMENT = '[^\\s"\'`<>|*?\\\\/,;()\\[\\]{}]+'
/** Space-separated words that a separator follows: still one directory name, not prose. */
const SPACED = `(?: +${SEGMENT}(?=[\\\\/]))*`
const TAIL = `((?:${SEP}${SEGMENT}${SPACED})*)(?:${SEP}(?=$|[^A-Za-z0-9._-]))?`

// Top-level directories absolute host paths live under; see the header.
const POSIX_HOST_DIRECTORIES = [
  'Users', 'home', 'root', 'tmp', 'var', 'private', 'opt', 'etc', 'mnt', 'media', 'Volumes', 'usr', 'srv',
  'run', 'proc', 'dev', 'nix', 'snap', 'Library', 'System', 'Applications', 'bin', 'sbin', 'lib', 'workspace',
]

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const caseFolding = (platform: NodeJS.Platform): boolean => platform === 'win32' || platform === 'darwin'

/** One root spelled as a pattern: every separator run, case and long-path prefix. */
const rootPattern = (path: string, platform: NodeJS.Platform): string | undefined => {
  const segments = path.split(/[\\/]+/u).filter(Boolean)
  if (segments.length === 0) return undefined
  const drive = /^([A-Za-z]):$/u.exec(segments[0]!)
  if (platform === 'win32' && drive) {
    const letter = drive[1]!
    // `C:`, `\\?\C:`, `//?/C:`, `\\.\C:`, and the MSYS/WSL spellings `/c/` and `/mnt/c/`.
    const head = `(?:(?:${SEP}[?.]${SEP})?(?<![A-Za-z0-9])${letter}:|(?<![A-Za-z0-9_.:>~-])/(?:mnt/)?${letter}(?=${SEP}))`
    const body = segments.slice(1).map(escapeRegExp).join(SEP)
    return body ? `${head}${SEP}${body}` : head
  }
  if (platform === 'win32' && /^[\\/]{2}/u.test(path)) {
    // UNC: `\\server\share\…`, also behind the `\\?\UNC\` prefix.
    return `(?:${SEP}[?]${SEP}UNC${SEP}|${SEP})${segments.map(escapeRegExp).join(SEP)}`
  }
  return `(?<![A-Za-z0-9_.:>~-])/+${segments.map(escapeRegExp).join('/+')}`
}

type Rule = { pattern: RegExp; replace: (tail: string) => string }

const relativeTail = (tail: string): string => tail.split(/[\\/]+/u).filter(Boolean).join('/')

export const createPathRewriter = (
  roots: readonly PathRewriteRoot[],
  platform: NodeJS.Platform = process.platform,
  identity: HostIdentity = NO_HOST_IDENTITY,
): PathRewriter => {
  const flags = caseFolding(platform) ? 'giu' : 'gu'
  const spelled = roots.flatMap((root) => [...new Set(root.paths)].map((path) => ({ name: root.name, path })))
  // Longest first, so a root under the home directory wins over home itself.
  spelled.sort((left, right) => right.path.length - left.path.length)
  const rules: Rule[] = []
  for (const entry of spelled) {
    const pattern = rootPattern(entry.path, platform)
    if (!pattern) continue
    rules.push({
      pattern: new RegExp(`${pattern}(?=$|[\\\\/]|[^A-Za-z0-9._-])${TAIL}`, flags),
      replace: (tail) => {
        if (entry.name === undefined) return HOST_PATH_PLACEHOLDER
        const relative = relativeTail(tail)
        return relative ? `<${entry.name}>/${relative}` : `<${entry.name}>`
      },
    })
  }
  const generic = [
    // Windows drive paths, with or without the long-path prefix.
    `(?:${SEP}[?.]${SEP})?(?<![A-Za-z0-9])[A-Za-z]:${SEP}(?:${SEGMENT}${SPACED}(?:${SEP}${SEGMENT}${SPACED})*)?`,
    // UNC shares.
    `(?<![A-Za-z0-9_\\\\/])\\\\{2}(?![?.][\\\\/])${SEGMENT}(?:${SEP}${SEGMENT}${SPACED})+`,
    // POSIX absolute paths under a host directory, and MSYS drive paths.
    // A single letter only when a slash follows (`/c/Users`), so `taskkill /T /F` survives.
    `(?<![A-Za-z0-9_.:>~\\\\-])/+(?:(?:${POSIX_HOST_DIRECTORIES.join('|')})(?=$|/|[^A-Za-z0-9._-])|[A-Za-z](?=/))`
      + `(?:/+${SEGMENT}${SPACED})*`,
    // Home-relative paths.
    `(?<![A-Za-z0-9_~])~(?:${SEP}${SEGMENT}${SPACED})+`,
  ]
  for (const source of generic) {
    rules.push({ pattern: new RegExp(source, caseFolding(platform) ? 'gi' : 'g'), replace: () => HOST_PATH_PLACEHOLDER })
  }
  const kept = [
    HOST_PATH_PLACEHOLDER, ACCOUNT_PLACEHOLDER, SECRET_PLACEHOLDER,
    ...roots.flatMap((root) => (root.name === undefined ? [] : [`<${root.name}>`])),
  ]
  const names = createIdentityRewrite(identity, kept)
  const branchNames = createIdentityRewrite(identity, kept, { everySegment: true })
  const rewritePaths = (text: string): string => {
    let current = text
    for (const rule of rules) {
      current = current.replace(rule.pattern, (_match, tail: unknown) => rule.replace(typeof tail === 'string' ? tail : ''))
    }
    return current
  }
  return {
    rewrite: (text) => (names ? names(rewritePaths(text)) : rewritePaths(text)),
    rewritePaths,
    rewriteBranch: (text) => (branchNames ? branchNames(rewritePaths(text)) : rewritePaths(text)),
  }
}
