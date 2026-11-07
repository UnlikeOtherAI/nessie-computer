import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep, win32 } from 'node:path'

/**
 * Where a secret the owner supplies is written: one file inside the session's
 * named folder, created owner-only (0600), never through a symbolic link or
 * a hard link, never outside the folder. The value is written once and goes
 * nowhere else — no log, receipt, conversation or error carries it, and
 * every refusal here names a category, never the path's contents or the value.
 *
 * With an `envName` the file is a dotenv file: one `NAME=value` line is set
 * or replaced and every other line is kept as it was. Without one, the file
 * is the value.
 */

export class SecretDestinationError extends Error {
  override readonly name = 'SecretDestinationError'
  constructor(readonly code: 'secret_destination_invalid' | 'secret_destination_refused') {
    super(code === 'secret_destination_invalid'
      ? 'The destination must be a file path relative to the session folder, without .. or a drive.'
      : 'The destination cannot be written: it leaves the session folder, or is a link or not a file.')
  }
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const MAX_DESTINATION = 1_000
const MAX_DOTENV_BYTES = 1024 * 1024

/** The destination as path segments, or a refusal: relative, no `..`, no drive, no empty or control characters. */
export const secretDestinationSegments = (destination: unknown): string[] => {
  if (typeof destination !== 'string' || !destination.trim() || destination.length > MAX_DESTINATION
    || /[\u0000-\u001f\u007f]/u.test(destination)
    || isAbsolute(destination) || posix.isAbsolute(destination) || win32.isAbsolute(destination)
    || /^[A-Za-z]:/u.test(destination)) {
    throw new SecretDestinationError('secret_destination_invalid')
  }
  const segments = destination.split(/[\\/]+/u).filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new SecretDestinationError('secret_destination_invalid')
  }
  return segments
}

/** The destination as a person reads it: forward slashes, relative to the session folder. */
export const normalizedSecretDestination = (destination: unknown): string => (
  secretDestinationSegments(destination).join('/')
)

const quoteDotenv = (value: string): string => (
  /^[A-Za-z0-9_./:@+-]*$/u.test(value) ? value
    : `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n').replace(/\r/gu, '\\r')}"`
)

/** Sets or replaces one `NAME=value` line (an `export NAME=…` line counts as one), keeping every other line. */
export const setDotenvLine = (content: string, name: string, value: string): string => {
  const line = `${name}=${quoteDotenv(value)}`
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'u')
  const lines = content === '' ? [] : content.replace(/\r?\n$/u, '').split(/\r?\n/u)
  let replaced = false
  const next = lines.flatMap((existing) => {
    if (!matcher.test(existing)) return [existing]
    if (replaced) return []
    replaced = true
    return [line]
  })
  if (!replaced) next.push(line)
  return `${next.join('\n')}\n`
}

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/**
 * Writes the secret. Every directory on the way is checked as it is reached
 * and created owner-only when missing; a link anywhere refuses the write, and
 * the file is replaced by a rename from a fresh 0600 file beside it, which
 * never follows a link a racing writer might put in its place.
 */
export const writeSecretToFolder = async (input: {
  folder: string; destination: string; value: string; envName?: string
}): Promise<{ destination: string }> => {
  const segments = secretDestinationSegments(input.destination)
  if (input.envName !== undefined && !ENV_NAME_PATTERN.test(input.envName)) {
    throw new SecretDestinationError('secret_destination_invalid')
  }
  const root = await realpath(input.folder)
    .catch(() => { throw new SecretDestinationError('secret_destination_refused') })
  let directory = root
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment)
    const info = await lstat(directory).catch(() => undefined)
    if (!info) {
      await mkdir(directory, { mode: 0o700 }).catch(() => { throw new SecretDestinationError('secret_destination_refused') })
    } else if (info.isSymbolicLink() || !info.isDirectory()) throw new SecretDestinationError('secret_destination_refused')
  }
  if (!within(root, await realpath(directory).catch(() => ''))) {
    throw new SecretDestinationError('secret_destination_refused')
  }
  const target = join(directory, segments.at(-1)!)
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1)) {
    throw new SecretDestinationError('secret_destination_refused')
  }
  let content = input.value
  if (input.envName !== undefined) {
    if (existing && existing.size > MAX_DOTENV_BYTES) throw new SecretDestinationError('secret_destination_refused')
    const previous = existing
      ? await readFile(target, 'utf8').catch(() => { throw new SecretDestinationError('secret_destination_refused') }) : ''
    content = setDotenvLine(previous, input.envName, input.value)
  }
  const temporary = join(directory, `.${segments.at(-1)!}.${randomUUID()}.tmp`)
  const refused = (): never => { throw new SecretDestinationError('secret_destination_refused') }
  const handle = await open(temporary, 'wx', 0o600).catch(refused)
  try {
    try {
      await handle.writeFile(content, 'utf8')
      await handle.chmod(0o600).catch(() => undefined)
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch {
    await unlink(temporary).catch(() => undefined)
    refused()
  }
  return { destination: segments.join('/') }
}
