import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  configureOrdinaryDirectory,
  isInsideDirectory,
  resolveExistingWorkspacePath,
  safeRelativeWorkspacePath,
} from '../workspace-paths.js'
import { CodingSessionConfigError, type LoadedCodingSessionsConfig } from './config.js'
import { readHostIdentity } from './host-identity.js'
import { createPathRewriter, type PathRewriter } from './path-rewrite.js'

/**
 * The folders a coding agent may be started in, resolved once per process.
 *
 * A root is refused outright when it overlaps the bridge's own state or the
 * config file: a coding agent acts with the host user's full authority, and
 * one that can write the inbox or the config could approve its own requests or
 * widen its own power. Roots may not nest either, for the reason workspace
 * folders may not: a path would then belong to two names.
 */
export type ResolvedCodingRoot = {
  name: string
  declared: string
  /** Absent while the directory is missing (an unplugged drive): that root alone is unavailable. */
  canonical?: string
}

export type CodingRootSet = {
  roots: ResolvedCodingRoot[]
  rewriter: PathRewriter
}

export class CodingRootError extends Error {
  override readonly name = 'CodingRootError'
  constructor(readonly code: 'root_unknown' | 'root_unavailable' | 'path_invalid', message: string) {
    super(message)
  }
}

const folded = (path: string, platform: NodeJS.Platform): string => (
  platform === 'win32' || platform === 'darwin' ? resolve(path).toLowerCase() : resolve(path)
)

/**
 * Whether either path contains the other, compared the way the host's
 * filesystem compares names: case-insensitively on Windows and macOS.
 */
export const codingPathsOverlap = (
  left: string, right: string, platform: NodeJS.Platform = process.platform,
): boolean => {
  const a = folded(left, platform)
  const b = folded(right, platform)
  return isInsideDirectory(a, b) || isInsideDirectory(b, a)
}

const overlapping = (left: string, right: string): boolean => codingPathsOverlap(left, right)

/** The canonical spelling of a path that may not exist yet: its nearest existing ancestor, realpathed. */
export const canonicalOrDeclared = async (path: string): Promise<string> => {
  const resolved = resolve(path)
  const real = await realpath(resolved).catch(() => undefined)
  if (real) return real
  const parent = dirname(resolved)
  if (parent === resolved) return resolved
  return join(await canonicalOrDeclared(parent), basename(resolved))
}

export const resolveCodingRoots = async (loaded: LoadedCodingSessionsConfig): Promise<CodingRootSet> => {
  const guarded = [
    await canonicalOrDeclared(loaded.stateDir), resolve(loaded.stateDir),
    await canonicalOrDeclared(loaded.configPath), resolve(loaded.configPath),
  ]
  const roots: ResolvedCodingRoot[] = []
  for (const root of loaded.config.roots) {
    const canonical = await configureOrdinaryDirectory(root.path, `The coding root "${root.name}"`).catch(() => undefined)
    const spellings = [resolve(root.path), ...(canonical ? [canonical] : [])]
    if (spellings.some((spelling) => guarded.some((path) => overlapping(spelling, path)))) {
      throw new CodingSessionConfigError(
        `The coding root "${root.name}" overlaps the coding-sessions state or its configuration file.`,
      )
    }
    for (const earlier of roots) {
      const earlierSpellings = [resolve(earlier.declared), ...(earlier.canonical ? [earlier.canonical] : [])]
      if (spellings.some((spelling) => earlierSpellings.some((other) => overlapping(spelling, other)))) {
        throw new CodingSessionConfigError(`The coding roots "${earlier.name}" and "${root.name}" overlap.`)
      }
    }
    roots.push({ name: root.name, declared: root.path, ...(canonical ? { canonical } : {}) })
  }
  const home = homedir()
  // Every profile beside this one, and the program directories: named outright,
  // so a spaced name at the end of a path (`C:\Users\Other Person`) is hidden whole.
  const profiles = await readdir(dirname(home)).then(
    (names) => names.slice(0, 64).map((name) => join(dirname(home), name)), () => [] as string[],
  )
  const programs = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'].flatMap((name) => process.env[name] ?? [])
  const hidden = [
    home, await realpath(home).catch(() => home), tmpdir(), await canonicalOrDeclared(tmpdir()), ...guarded,
    ...profiles, ...programs,
  ]
  return {
    roots,
    // The OS user and host are hidden with the paths, by the same rewriter
    // every projected event and every answer passes through.
    rewriter: createPathRewriter([
      ...roots.map((root) => ({
        name: root.name, paths: [root.declared, ...(root.canonical ? [root.canonical] : [])],
      })),
      { name: undefined, paths: hidden },
    ], process.platform, readHostIdentity()),
  }
}

export const findCodingRoot = (set: CodingRootSet, name: unknown): ResolvedCodingRoot => {
  const root = set.roots.find((entry) => entry.name === name)
  if (!root) throw new CodingRootError('root_unknown', 'That root is not one this machine names for coding sessions.')
  return root
}

/** Root-relative and normalised, refusing `..`, absolute paths and journal state. */
export const normalizeCodingPath = (value: unknown): string => {
  if (value !== undefined && typeof value !== 'string') throw new CodingRootError('path_invalid', 'path must be a string.')
  try {
    return safeRelativeWorkspacePath(value)
  } catch {
    throw new CodingRootError('path_invalid', 'path must be a relative folder inside the root.')
  }
}

/** The canonical working folder for a session: an existing directory beneath the root, no links. */
export const resolveCodingFolder = async (root: ResolvedCodingRoot, path: string): Promise<string> => {
  if (!root.canonical) throw new CodingRootError('root_unavailable', `The root "${root.name}" is not available right now.`)
  let folder: string
  try {
    folder = await resolveExistingWorkspacePath(root.canonical, path)
  } catch {
    throw new CodingRootError('path_invalid', 'path must name an existing folder inside the root.')
  }
  if (!(await lstat(folder)).isDirectory()) throw new CodingRootError('path_invalid', 'path must name a folder.')
  return folder
}
