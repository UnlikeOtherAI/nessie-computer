import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execute = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const lock = JSON.parse(readFileSync(new URL('./source-lock.json', import.meta.url), 'utf8'))

/** Build-input provenance only. This is never a personal credential admission proof. */
export const T3_SESSION_ENGINE_SOURCE = Object.freeze({
  ...lock, roots: Object.freeze(lock.roots), files: Object.freeze(lock.files),
})

export class SessionEngineSourceError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SessionEngineSourceError'
    this.code = code
  }
}

const refuse = code => { throw new SessionEngineSourceError(code) }
const regularPath = value => typeof value === 'string' && value.split('/').every(
  part => /^[a-zA-Z0-9_@%+.-]+$/u.test(part) && part !== '.' && part !== '..' && part !== '.git',
)

const validateLock = spec => {
  if (spec.format !== 1 || !/^[a-f0-9]{40}$/u.test(spec.commit) || !/^[a-f0-9]{40}$/u.test(spec.tree)
    || !/^[a-f0-9]{64}$/u.test(spec.archiveSha256) || !Number.isSafeInteger(spec.archiveBytes)
    || spec.archiveBytes <= 0 || !Array.isArray(spec.roots) || spec.roots.length === 0
    || !spec.roots.every(regularPath) || !spec.files || typeof spec.files !== 'object'
    || Object.keys(spec.files).length === 0) refuse('SESSION_ENGINE_SOURCE_LOCK_INVALID')
  for (const [file, digest] of Object.entries(spec.files)) {
    if (!regularPath(file) || !/^[a-f0-9]{64}$/u.test(digest)
      || !spec.roots.some(root => file === root || file.startsWith(`${root}/`))) {
      refuse('SESSION_ENGINE_SOURCE_LOCK_INVALID')
    }
  }
}

const git = async (repository, args) => {
  try {
    const result = await execute('git', ['--no-replace-objects', '-C', resolve(repository), ...args], {
      encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 120_000, windowsHide: true,
    })
    return result.stdout
  } catch {
    // Git's stderr and paths may contain local information; neither leaves this boundary.
    return refuse('SESSION_ENGINE_SOURCE_UNREADABLE')
  }
}

/**
 * Verify committed objects, never a working tree. Explicit specs support isolated
 * build-tool fixtures; a caller-supplied spec confers no runtime authority.
 */
export const verifySessionEngineSource = async (sourceRepository, spec = T3_SESSION_ENGINE_SOURCE) => {
  validateLock(spec)
  const tree = (await git(sourceRepository, ['rev-parse', `${spec.commit}^{tree}`])).toString('utf8').trim()
  if (tree !== spec.tree) refuse('SESSION_ENGINE_SOURCE_IDENTITY_MISMATCH')
  const entries = (await git(sourceRepository, ['ls-tree', '-r', '-z', spec.commit, '--', ...spec.roots]))
    .toString('utf8').split('\0').filter(Boolean)
  if (entries.length === 0) refuse('SESSION_ENGINE_SOURCE_EMPTY')
  const paths = new Set()
  for (const entry of entries) {
    const separator = entry.indexOf('\t')
    const metadata = entry.slice(0, separator).split(' ')
    const file = entry.slice(separator + 1)
    if (separator < 0 || !['100644', '100755'].includes(metadata[0]) || metadata[1] !== 'blob'
      || !spec.roots.some(root => file === root || file.startsWith(`${root}/`))) {
      refuse('SESSION_ENGINE_SOURCE_ENTRY_REFUSED')
    }
    paths.add(file)
  }
  for (const root of spec.roots) {
    if (![...paths].some(file => file === root || file.startsWith(`${root}/`))) {
      refuse('SESSION_ENGINE_SOURCE_ROOT_MISSING')
    }
  }
  for (const [file, expected] of Object.entries(spec.files)) {
    const bytes = await git(sourceRepository, ['show', `${spec.commit}:${file}`])
    if (sha256(bytes) !== expected) refuse('SESSION_ENGINE_SOURCE_FILE_MISMATCH')
  }
  return { commit: spec.commit, tree: spec.tree, sourceFiles: entries.length }
}

/**
 * Produce a verified offline source capsule for a later engine build. No install,
 * lifecycle script, provider, T3 executable or source file is executed. No user
 * state is read. The capsule is a build input, not a runnable executor payload.
 */
export const prepareSessionEngineSource = async (
  { sourceRepository, archivePath }, spec = T3_SESSION_ENGINE_SOURCE,
) => {
  const identity = await verifySessionEngineSource(sourceRepository, spec)
  const archive = await git(sourceRepository, ['archive', '--format=tar', spec.commit, '--', ...spec.roots])
  if (archive.length !== spec.archiveBytes || sha256(archive) !== spec.archiveSha256) {
    refuse('SESSION_ENGINE_SOURCE_ARCHIVE_MISMATCH')
  }
  const destination = resolve(archivePath)
  await mkdir(dirname(destination), { recursive: true })
  const existing = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== spec.archiveBytes
      || sha256(await readFile(destination)) !== spec.archiveSha256) {
      refuse('SESSION_ENGINE_SOURCE_OUTPUT_CONFLICT')
    }
  } else {
    // Never overwrite an existing artifact, even if another preparation raced us.
    await writeFile(destination, archive, { flag: 'wx', mode: 0o600 })
  }
  return { ...identity, archiveSha256: spec.archiveSha256, archiveBytes: spec.archiveBytes, reused: Boolean(existing) }
}

const main = async args => {
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--archive') {
    refuse('Usage: node packaging/session-engine/source.mjs --source <Git repository> --archive <new source.tar>')
  }
  const result = await prepareSessionEngineSource({ sourceRepository: args[1], archivePath: args[3] })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof SessionEngineSourceError ? error.code : 'SESSION_ENGINE_SOURCE_PREPARATION_FAILED'}\n`)
    process.exitCode = 1
  })
}
