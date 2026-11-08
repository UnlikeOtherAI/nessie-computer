import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { T3_SESSION_ENGINE_SOURCE } from './source.mjs'

const execute = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const clientSourceManifestBytes = readFileSync(new URL('./client-source.json', import.meta.url))
export const clientSourceManifest = Object.freeze(JSON.parse(clientSourceManifestBytes))

/** Supplement the server/packages capsule with only the exact admitted mobile Git objects. */
export const readClientSourceInputs = async (snapshot, repository) => {
  const manifest = clientSourceManifest
  if (!repository || manifest.format !== 1 || snapshot.identity.commit !== manifest.sourceCommit
    || snapshot.identity.tree !== manifest.sourceTree || manifest.sourceCommit !== T3_SESSION_ENGINE_SOURCE.commit
    || manifest.sourceTree !== T3_SESSION_ENGINE_SOURCE.tree) {
    throw new Error('CLIENT_SOURCE_IDENTITY_MISMATCH')
  }
  const git = async args => (await execute('git', ['--no-replace-objects', '-C', resolve(repository), ...args],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 10_000, windowsHide: true })).stdout
  const tree = (await git(['rev-parse', `${manifest.sourceCommit}^{tree}`])).toString('utf8').trim()
  if (tree !== manifest.sourceTree) throw new Error('CLIENT_SOURCE_TREE_MISMATCH')
  const inputs = new Map()
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!/^apps\/mobile\/src\/[\w/-]+\.ts$/u.test(file) || file.includes('..') || snapshot.files.includes(file)) {
      throw new Error('CLIENT_SOURCE_PATH_REFUSED')
    }
    const bytes = await git(['show', `${manifest.sourceCommit}:${file}`])
    if (digest(bytes) !== expected) throw new Error(`CLIENT_SOURCE_HASH_MISMATCH:${file}`)
    inputs.set(file, bytes)
  }
  return Object.freeze({
    identity: Object.freeze({ ...snapshot.identity, mobileClientManifestSha256: digest(clientSourceManifestBytes) }),
    files: Object.freeze([...snapshot.files, ...inputs.keys()].sort()),
    read: file => inputs.has(file) ? Buffer.from(inputs.get(file)) : snapshot.read(file),
  })
}
