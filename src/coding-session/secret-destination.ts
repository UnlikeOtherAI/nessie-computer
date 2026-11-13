import type { SessionEffectAuthority } from './session-effect-authority.js'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, posix, win32 } from 'node:path'

import {
  assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile, type StateSecurityDeps,
} from '../state-security.js'

/**
 * Where a secret the owner supplies is written: one file directly in the
 * session's named folder — never a subdirectory, never through a symbolic or
 * hard link, never outside the folder — created owner-only. The value is
 * written once and goes nowhere else: no log, receipt, conversation or error
 * carries it, and every refusal names a category, never the path's contents
 * or the value.
 *
 * The executor writes it unsandboxed while the agent, which can write in the
 * folder, may be racing it, so nothing is trusted between a check and a use:
 * an existing file is read through a handle opened without following a link
 * and proved on that handle to be one ordinary file with one name; the new
 * file is created exclusively, made owner-only before the value is in it
 * (on Windows through the state-security helper, whose DACL Node's mode bits
 * cannot set) and proved so; and the folder is the same directory (device
 * and inode) before the read, before the rename and after it, with the
 * renamed file the one this write created. Any difference refuses the write.
 *
 * With an `envName` the file is a dotenv file: one `NAME=value` line is set
 * or replaced and every other line is kept as it was. Without one, the file
 * is the value.
 */

export class SecretDestinationError extends Error {
  override readonly name = 'SecretDestinationError'
  constructor(readonly code: 'secret_destination_invalid' | 'secret_destination_refused') {
    super(code === 'secret_destination_invalid'
      ? 'The destination must be a file name in the session folder itself, such as .env.local: no folders, .. or drive.'
      : 'The destination cannot be written: it leaves the session folder, or is a link or not a file.')
  }
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const MAX_DESTINATION = 1_000
/** Room for the temporary sibling's prefix and suffix inside a 255-byte file name. */
const MAX_NAME = 200
const MAX_DOTENV_BYTES = 1024 * 1024

/** The destination's one segment, or a refusal: a file name in the folder itself, not a path into it. */
export const secretDestinationSegments = (destination: unknown): string[] => {
  if (typeof destination !== 'string' || !destination.trim() || destination.length > MAX_DESTINATION
    || /[\u0000-\u001f\u007f]/u.test(destination)
    || isAbsolute(destination) || posix.isAbsolute(destination) || win32.isAbsolute(destination)
    || /^[A-Za-z]:/u.test(destination)) {
    throw new SecretDestinationError('secret_destination_invalid')
  }
  const segments = destination.split(/[\\/]+/u).filter((segment) => segment !== '' && segment !== '.')
  // A Windows stream (`name:stream`) or a name Windows trims (`name.`) is another file than the one shown.
  if (segments.length !== 1 || segments[0] === '..' || segments[0]!.length > MAX_NAME || /[:]|[. ]$/u.test(segments[0]!)) {
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

type Identity = { dev: number; ino: number }
const sameFile = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino

const refuse = (): never => { throw new SecretDestinationError('secret_destination_refused') }

/** The folder, still the very directory it was: not replaced, not a link. */
const folderUnchanged = async (root: string, identity: Identity): Promise<void> => {
  const now = await lstat(root).catch(refuse)
  if (now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, identity)) refuse()
}

type SecretStaging = { path: string; verify: () => Promise<void>; cleanup: () => Promise<void> }

/** Windows mode bits cannot make a new file private: inherit a private DACL at birth. */
const secretStaging = async (root: string, name: string, security?: StateSecurityDeps): Promise<SecretStaging> => {
  const file = `.${name}.${randomUUID()}.tmp`
  if ((security?.platform ?? process.platform) !== 'win32') {
    return { path: join(root, file), verify: async () => undefined, cleanup: async () => undefined }
  }
  const directory = await mkdtemp(join(root, '.nessie-secret-')).catch(refuse)
  const identity = await lstat(directory).catch(refuse)
  if (identity.isSymbolicLink() || !identity.isDirectory()) refuse()
  const verify = () => folderUnchanged(directory, identity)
  // Empty only; never recurse into or follow a raced path.
  const cleanup = async () => {
    try { await verify(); await rmdir(directory) } catch { /* Retain uncertain or nonempty staging. */ }
  }
  try {
    await ensureOwnerOnlyStateDirectory(directory, security)
    await verify()
    return { path: join(directory, file), verify, cleanup }
  } catch { await cleanup(); return refuse() }
}

/** `O_NOFOLLOW` where the platform has it; Windows has none, so the handle and the name are compared instead. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

/** The existing file's text, read through a handle proved to be the one ordinary, singly linked file there. */
const readExisting = async (target: string, readText: boolean): Promise<{ found: boolean; text: string }> => {
  let handle: FileHandle
  try {
    handle = await open(target, READ_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Nothing there now, and nothing that is a link either.
      if (await lstat(target).then(() => true, () => false)) refuse()
      return { found: false, text: '' }
    }
    return refuse()
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || (readText && info.size > MAX_DOTENV_BYTES)) refuse()
    const text = readText ? await handle.readFile('utf8') : ''
    const named = await lstat(target).catch(refuse)
    if (named.isSymbolicLink() || !sameFile(named, info)) refuse()
    return { found: true, text }
  } finally {
    await handle.close()
  }
}

/** The value of `NAME=…` as `setDotenvLine` writes it (quoted and escaped, or bare), or undefined. */
export const dotenvValue = (content: string, name: string): string | undefined => {
  const line = content.split(/\r?\n/u).find((entry) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'u').test(entry))
  const raw = line?.slice(line.indexOf('=') + 1).trim()
  if (raw === undefined) return undefined
  if (!raw.startsWith('"')) return raw
  const quoted = /^"((?:[^"\\]|\\.)*)"/u.exec(raw)?.[1]
  return quoted?.replace(/\\(.)/gu, (_, character: string) => (
    character === 'n' ? '\n' : character === 'r' ? '\r' : character))
}

/** How a value is spelled in the file it was written to, beside the value itself: both are what `cat` shows. */
export const secretSpellings = (value: string): string[] => {
  const quoted = quoteDotenv(value)
  return quoted === value ? [value] : [value, quoted.slice(1, -1)]
}

/**
 * Reads back a value the owner supplied, as safely as it was written: a file
 * directly in the folder, through a handle that follows no link.
 */
export const readSecretFromFolder = async (input: {
  folder: string; destination: string; envName?: string
}): Promise<string | undefined> => {
  const [name] = secretDestinationSegments(input.destination) as [string]
  const root = await realpath(input.folder).catch(refuse)
  const folder = await lstat(root).catch(refuse)
  if (folder.isSymbolicLink() || !folder.isDirectory()) refuse()
  const existing = await readExisting(join(root, name), true)
  await folderUnchanged(root, folder)
  if (!existing.found) return undefined
  return input.envName === undefined ? existing.text : dotenvValue(existing.text, input.envName)
}

/**
 * Writes the secret into the one file the destination names, directly in the
 * folder. `security` reaches the state-security module (its tests use it to
 * stand in for the Windows helper); `seams` lets a test move things between
 * the steps, as a racing agent would.
 */
export const writeSecretToFolder = async (input: {
  folder: string; destination: string; value: string; envName?: string
  effect?: SessionEffectAuthority
  security?: StateSecurityDeps
  seams?: { afterRead?: () => Promise<void>; beforeRename?: () => Promise<void> }
}): Promise<{ destination: string }> => {
  const [name] = secretDestinationSegments(input.destination) as [string]
  if (input.envName !== undefined && !ENV_NAME_PATTERN.test(input.envName)) {
    throw new SecretDestinationError('secret_destination_invalid')
  }
  const root = await realpath(input.folder).catch(refuse)
  const folder = await lstat(root).catch(refuse)
  if (folder.isSymbolicLink() || !folder.isDirectory()) refuse()
  const target = join(root, name)
  const existing = await readExisting(target, input.envName !== undefined)
  await folderUnchanged(root, folder)
  await input.seams?.afterRead?.()
  const content = input.envName === undefined ? input.value : setDotenvLine(existing.text, input.envName, input.value)
  await folderUnchanged(root, folder)
  const staging = await secretStaging(root, name, input.security)
  const temporary = staging.path
  // Exclusive: a name a racing writer put there, link or not, fails the open rather than being followed.
  const handle = await open(temporary, 'wx', 0o600).catch(async () => { await staging.cleanup(); return refuse() })
  let created: Identity | undefined
  try {
    try {
      created = await handle.stat()
      await staging.verify()
      await handle.chmod(0o600).catch(() => undefined)
      // Owner-only before the value is in it, and proved so on the file this write created.
      await secureOwnerOnlyStateFile(temporary, input.security)
      await assertOwnerOnlyStatePath(temporary, 'file', input.security)
      if (!sameFile(await lstat(temporary), created)) refuse()
      await input.effect?.consume()
      input.effect?.assertLive()
      await staging.verify()
      await folderUnchanged(root, folder)
      input.effect?.assertLive()
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await input.seams?.beforeRename?.()
    await folderUnchanged(root, folder)
    await staging.verify()
    const staged = await lstat(temporary)
    if (staged.isSymbolicLink() || !sameFile(staged, created)) refuse()
    await input.effect?.consume()
    input.effect?.assertLive()
    await rename(temporary, target)
  } catch {
    try {
      await staging.verify()
      if (created && sameFile(await lstat(temporary), created)) await unlink(temporary)
    } catch { /* An uncertain staging identity is retained, never followed for cleanup. */ }
    refuse()
  } finally { await staging.cleanup() }
  // The rename landed in the same folder, as the file this write created.
  await folderUnchanged(root, folder)
  const placed = await lstat(target).catch(refuse)
  if (placed.isSymbolicLink() || placed.nlink !== 1 || !sameFile(placed, created!)) refuse()
  await assertOwnerOnlyStatePath(target, 'file', input.security)
  return { destination: name }
}
