import { closeSync, openSync, readSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'

/**
 * The OS user and host names, which a coding agent's output repeats without
 * any path around them: git's `unable to auto-detect email address (got
 * 'ondre@Minis.(none)')` in the live Windows run, `npm whoami`, a Git Bash
 * prompt, `whoami` itself. Each becomes `<user>` or `<host>` before it
 * leaves the machine.
 *
 * Every spelling this process can see is collected: `os.userInfo()`,
 * `USERNAME`, `USER` and `LOGNAME` for the user; `os.hostname()` and
 * `COMPUTERNAME`, each whole and by its first label, `<short>.<USERDNSDOMAIN>`
 * on a Windows domain and the NetBIOS form (the first 15 characters) on
 * Windows, and elsewhere the FQDN forms the machine states itself —
 * `/etc/hosts` aliases of the short name and `<short>.<domain>` for each
 * `/etc/resolv.conf` search domain — so git's `ondre@minis.corp.acme.com`
 * leaves no DNS domain behind either. The MCP SDK hands the bridge a minimal
 * environment, so the `os` answers are the ones that always arrive. The home
 * directory's own name is not one: under a container or a service account it
 * is `/app`, `/workspace` or `/tmp`, and the account names above already
 * cover a person's.
 *
 * A name is matched as a whole word and case-insensitively. One shorter than
 * three characters, and one any machine may carry (`root`, `admin`, `node`,
 * `ubuntu`, `claude`, …: the usual defaults of CI runners, containers, cloud
 * images and the coding agents themselves), is left alone: it would rewrite
 * ordinary words and fixed values, and hide nobody. So is a match that is one
 * whole segment of a relative path (a single `/` or `\` before it, one after):
 * such a segment is a repository's own folder (`src/api/x.ts`), a URL's owner
 * (`github.com/ondre/app`) or a folder under a root (`<app>/ondre/y.ts`), and
 * rewriting it would hand the model a path that does not exist. A segment of
 * an absolute path is never one of those: the path rules rewrite only the
 * host directories they name, so `/data/ondre/x`, `//server/share/ondre` or
 * `~other/ondre` reach this pass with the name still in them. A path counts
 * as absolute when it starts — after whitespace, a quote, a bracket, `=`,
 * `,`, `;`, `|` or a `:` that is not a URL's `://`, and past a redirection
 * (`>`, `2>>`, `<`), `@`, `*` or a one-letter option (`-o`, `-I`) in front of
 * it — with `/`, `\`, `~`, a drive letter (`D:data\…` too) or `file:`; a
 * path that goes on from a closing bracket (`$(pwd)/…`) does not. A route
 * with no host (`/api/ondre/runs`) and a glob that starts at `*` cannot be
 * told from an absolute path and are rewritten, and a directory with a
 * space in its name ends the path at the space. A branch (`everySegment`) is
 * a name, not a path the model resolves, so none of its segments is left
 * alone.
 */
export const USER_PLACEHOLDER = '<user>'
export const HOST_PLACEHOLDER = '<host>'

export type HostIdentity = { users: readonly string[]; hosts: readonly string[] }

export const NO_HOST_IDENTITY: HostIdentity = { users: [], hosts: [] }

const MIN_NAME_LENGTH = 3
const MAX_NAMES = 24
const GENERIC_NAMES = new Set([
  'root', 'user', 'admin', 'administrator', 'guest', 'nobody', 'system', 'localhost', 'localhost.localdomain',
  // The coding agents, whose names are also fixed values in every answer (`agent: 'claude'`).
  'claude', 'codex',
  // CI runners, containers and cloud images.
  'runner', 'ubuntu', 'debian', 'fedora', 'centos', 'alpine', 'node', 'app', 'vscode', 'codespace', 'codespaces',
  'git', 'vagrant', 'jenkins', 'docker', 'ec2-user', 'azureuser', 'cloud-user', 'raspberrypi', 'www-data', 'daemon',
  // Hosts and accounts named for what they do.
  'dev', 'build', 'test', 'web', 'api', 'server', 'worker', 'mac', 'macbook', 'macbook-pro', 'macbook-air', 'imac',
  'workspace', 'tmp', 'home', 'default',
])

const attempt = (read: () => string): string | undefined => {
  try {
    return read()
  } catch {
    // os.userInfo() throws for a uid with no passwd entry (a container).
    return undefined
  }
}

/** Trimmed, long enough, not generic, one entry per name however it is cased. */
export const identityNames = (values: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const name = value?.trim()
    if (!name || name.length < MIN_NAME_LENGTH || /[\p{Cc}]/u.test(name)) continue
    const folded = name.toLowerCase()
    if (GENERIC_NAMES.has(folded) || seen.has(folded)) continue
    seen.add(folded)
    names.push(name)
  }
  return names.slice(0, MAX_NAMES)
}

/** At most the first 256 KiB of a system file, or `undefined`: an ad-blocking `/etc/hosts` runs to megabytes. */
const readSystemFile = (path: string): string | undefined => {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(256 * 1024)
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/u

/** What `/etc/hosts` and `/etc/resolv.conf` say this machine is called, fully qualified. */
const qualifiedNames = (short: string, read: (path: string) => string | undefined): string[] => {
  const folded = short.toLowerCase()
  const names: string[] = []
  for (const line of (read('/etc/hosts') ?? '').split('\n').slice(0, 4_096)) {
    const aliases = line.replace(/#.*$/u, '').trim().split(/\s+/u).slice(1)
    if (!aliases.some((alias) => alias.toLowerCase() === folded || alias.toLowerCase().startsWith(`${folded}.`))) continue
    names.push(...aliases.filter((alias) => alias.toLowerCase().startsWith(`${folded}.`)))
  }
  for (const line of (read('/etc/resolv.conf') ?? '').split('\n').slice(0, 256)) {
    const [keyword, ...domains] = line.trim().split(/\s+/u)
    if (keyword !== 'search' && keyword !== 'domain') continue
    for (const domain of domains.slice(0, 6)) {
      const bare = domain.replace(/\.$/u, '')
      if (bare && HOST_NAME.test(bare)) names.push(`${short}.${bare}`)
    }
  }
  return names.filter((name) => HOST_NAME.test(name)).slice(0, 8)
}

export const readHostIdentity = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  read: (path: string) => string | undefined = readSystemFile,
): HostIdentity => {
  const hosts: string[] = []
  for (const name of [attempt(hostname), env.COMPUTERNAME]) {
    if (!name) continue
    const short = name.split('.')[0]!
    hosts.push(name, short)
    if (platform === 'win32') hosts.push(short.slice(0, 15))
    if (env.USERDNSDOMAIN) hosts.push(`${short}.${env.USERDNSDOMAIN}`)
    if (platform !== 'win32') hosts.push(...qualifiedNames(short, read))
  }
  return {
    users: identityNames([attempt(() => userInfo().username), env.USERNAME, env.USER, env.LOGNAME]),
    hosts: identityNames(hosts),
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** A session id, an agent session id: a hex group of one may spell a short host name. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const separator = (character: string | undefined): boolean => character === '/' || character === '\\'

const BEFORE_PATH = /[\s"'`()[\]{}=,;|]/u
/** What may stand in front of a path without being part of it: a redirection, `@file`, `**`, `-o` or `-I`. */
const LEADING = /^(?:[0-9&]?[<>]+[&|]?|[@*]+|-[A-Za-z](?=[\\/]))/u
const ABSOLUTE = /^(?:[\\/~]|[A-Za-z]:|file:)/iu
/** `$(pwd)/…`, `${ROOT}/…`: a path that goes on from what a shell or a template expands. */
const CLOSING = /[)\]}]/u

/** Whether a path or URL begins at `start`; see the header for what ends one. */
const beginsAt = (text: string, start: number): boolean => {
  const previous = text[start - 1]!
  return BEFORE_PATH.test(previous) || (previous === ':' && separator(text[start]) && !separator(text[start + 1]))
}

/**
 * Where the path or URL holding each offset begins, for offsets asked left to
 * right as a replace visits them: each scan stops where the last one started,
 * so a text is read once however many names one long token holds. Scanning
 * back to the start for each name made a 60 KB token of `ondre/ondre/…` take
 * seconds, and blocked the host's heartbeat with it.
 */
const pathStarts = (text: string): ((offset: number) => number) => {
  let scanned = 0
  let start = 0
  return (offset) => {
    if (offset < scanned) {
      scanned = 0
      start = 0
    }
    for (let at = offset; at > scanned; at -= 1) {
      if (!beginsAt(text, at)) continue
      start = at
      break
    }
    scanned = offset
    return start
  }
}

/**
 * One whole segment of a relative path or a URL's path: one separator before
 * it (not two, which is a URL's host or a UNC server), one after, and a path
 * around it that does not start at the root of anything on this machine.
 */
const relativeSegment = (
  text: string, offset: number, length: number, startOf: (offset: number) => number,
): boolean => {
  if (!separator(text[offset - 1]) || separator(text[offset - 2]) || !separator(text[offset + length])) return false
  const start = startOf(offset)
  if (CLOSING.test(text[start - 1] ?? '')) return true
  return !ABSOLUTE.test(text.slice(start, Math.min(offset, start + 24)).replace(LEADING, ''))
}

/**
 * The rewrite itself. `keep` are the placeholders already written (`<host
 * path>`, `<root>`, `<account>`, …), which are never rewritten again, so a
 * user who happens to be called `host` does not turn `<host path>` inside out.
 */
export const createIdentityRewrite = (
  identity: HostIdentity, keep: readonly string[], { everySegment = false }: { everySegment?: boolean } = {},
): ((text: string) => string) | undefined => {
  const hosts = identityNames(identity.hosts)
  const hostSet = new Set(hosts.map((name) => name.toLowerCase()))
  const names = [
    ...hosts.map((name) => ({ name, placeholder: HOST_PLACEHOLDER })),
    ...identityNames(identity.users).filter((name) => !hostSet.has(name.toLowerCase()))
      .map((name) => ({ name, placeholder: USER_PLACEHOLDER })),
  ]
  if (names.length === 0) return undefined
  // Longest first, so `Minis.local` is one host rather than a host and a suffix.
  names.sort((left, right) => right.name.length - left.name.length)
  const kept = [...new Set([...keep, USER_PLACEHOLDER, HOST_PLACEHOLDER])].map(escapeRegExp)
  const pattern = new RegExp(
    `(${[...kept, UUID].join('|')})|(?<![\\p{L}\\p{N}_])(?:${names.map((entry) => `(${escapeRegExp(entry.name)})`).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  )
  return (text) => {
    const startOf = pathStarts(text)
    return text.replace(pattern, (match: string, placeholder: string | undefined, ...rest: unknown[]) => {
      if (placeholder !== undefined) return match
      const offset = rest[names.length] as number
      if (!everySegment && relativeSegment(text, offset, match.length, startOf)) return match
      const index = rest.slice(0, names.length).findIndex((group) => group !== undefined)
      return names[index]?.placeholder ?? match
    })
  }
}
