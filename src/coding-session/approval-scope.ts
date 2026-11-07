import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { isInsideDirectory } from '../workspace-paths.js'

/**
 * How far an owner's approval reaches. An approval is the owner's decision
 * about what they were shown, so nothing it grants may reach further than
 * that, and nothing reaches past the reviewed named folders:
 *
 * - Claude Code's "for this session" adds only concrete rules — Claude's own
 *   suggested rule content, or the exact command the owner read — never a
 *   bare tool name that would allow every later use of the tool, and never a
 *   rule for a path-scoped tool, whose reach a request cannot show. Extra
 *   directories are kept only inside a reviewed folder.
 * - A Codex permissions request is granted for its turn alone, and only when
 *   every file-system path it names is inside a reviewed folder.
 */

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const fold = (path: string, platform: NodeJS.Platform): string => (
  platform === 'win32' || platform === 'darwin' ? path.toLowerCase() : path
)

/** True when `path` is absolute and both its spelling and its real location are inside one of the roots. */
const real = (path: string): string => {
  try { return realpathSync.native(path) } catch { return path }
}

export const insideReviewedRoots = (
  path: string, roots: readonly string[], platform: NodeJS.Platform = process.platform,
): boolean => {
  if (!isAbsolute(path)) return false
  const spelled = resolve(path)
  // A root is matched under both its spellings; the path's real location must be inside one as well.
  const rootSpellings = roots.flatMap((root) => [resolve(root), real(resolve(root))])
    .map((root) => fold(root, platform))
  return [spelled, real(spelled)].every((candidate) => rootSpellings.some((root) => (
    isInsideDirectory(root, fold(candidate, platform))
  )))
}

/** Tools whose rules name paths (`Read(//etc/**)`): what such a rule reaches is not what one request shows. */
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS'])
/** Rule content that matches anything (`*`, `:*`) is the bare tool by another name. */
const ANY_CONTENT = /^[\s*:]*$/u

const concreteRule = (rule: unknown): boolean => (
  record(rule) && typeof rule.toolName === 'string' && typeof rule.ruleContent === 'string'
  && !ANY_CONTENT.test(rule.ruleContent) && !PATH_TOOLS.has(rule.toolName)
)

/**
 * Claude Code's `updatedPermissions` for accepting a prompt for this session,
 * or undefined when nothing concrete can be offered, in which case the
 * request does not offer `accept_for_session` at all.
 */
export const claudeSessionRules = (
  prompt: { toolName: string; input: Record<string, unknown>; suggestions?: unknown[] },
  folder: string, roots: readonly string[],
): Record<string, unknown>[] | undefined => {
  const kept = (prompt.suggestions ?? []).filter(record).flatMap((suggestion): Record<string, unknown>[] => {
    if (suggestion.type === 'addRules' && Array.isArray(suggestion.rules)) {
      const rules = suggestion.rules.filter(concreteRule)
      return rules.length ? [{ ...suggestion, rules, destination: 'session' }] : []
    }
    if (suggestion.type === 'addDirectories' && Array.isArray(suggestion.directories)) {
      const directories = suggestion.directories.filter((directory): directory is string => (
        typeof directory === 'string' && insideReviewedRoots(resolve(folder, directory), roots)))
      return directories.length ? [{ ...suggestion, directories, destination: 'session' }] : []
    }
    // Modes, removals and replacements are never what the owner was shown.
    return []
  })
  if (kept.length) return kept
  const command = prompt.toolName === 'Bash' ? prompt.input.command : undefined
  // The exact command the owner read. A `*` would turn it into a pattern, so such a command is approved once only.
  if (typeof command === 'string' && command.trim() && !/[*\r\n]/u.test(command)) {
    return [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: command }], behavior: 'allow', destination: 'session' }]
  }
  return undefined
}

const insideProject = (subpath: unknown): boolean => (
  subpath === null || subpath === undefined
  || (typeof subpath === 'string' && !isAbsolute(subpath) && !subpath.split(/[\\/]/u).includes('..'))
)

/** One `entries` item of a Codex file-system permission: a denial, a path inside the roots, or the project itself. */
const entryWithin = (entry: unknown, cwd: string, roots: readonly string[]): boolean => {
  if (!record(entry) || !record(entry.path)) return false
  if (entry.access === 'deny') return true
  const { path } = entry
  if (path.type === 'path') return typeof path.path === 'string' && insideReviewedRoots(resolve(cwd, path.path), roots)
  return path.type === 'special' && record(path.value) && path.value.kind === 'project_roots' && insideProject(path.value.subpath)
}

/**
 * Whether everything a Codex permissions request asks for stays inside the
 * reviewed folders: network access may be asked for (and is shown), but a
 * file-system path, glob or special location outside them may not, and
 * anything this executor cannot read counts as outside.
 */
export const codexPermissionsWithinRoots = (permissions: unknown, cwd: string, roots: readonly string[]): boolean => {
  if (!record(permissions) || Object.keys(permissions).some((key) => key !== 'network' && key !== 'fileSystem')) return false
  const fileSystem = permissions.fileSystem
  if (fileSystem === null || fileSystem === undefined) return true
  if (!record(fileSystem)) return false
  if (Object.keys(fileSystem).some((key) => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key))) return false
  const listed = [fileSystem.read, fileSystem.write].every((paths) => paths === null || paths === undefined || (
    Array.isArray(paths) && paths.every((path) => typeof path === 'string' && insideReviewedRoots(resolve(cwd, path), roots))))
  const entries = fileSystem.entries === undefined
    || (Array.isArray(fileSystem.entries) && fileSystem.entries.every((entry) => entryWithin(entry, cwd, roots)))
  return listed && entries
}

/** What a Codex permissions grant carries: the asked profile without its empty parts, for this turn only. */
export const codexTurnGrant = (permissions: unknown): Record<string, unknown> => {
  const asked = record(permissions) ? permissions : {}
  return {
    permissions: {
      ...(record(asked.network) ? { network: asked.network } : {}),
      ...(record(asked.fileSystem) ? { fileSystem: asked.fileSystem } : {}),
    },
    scope: 'turn',
  }
}
