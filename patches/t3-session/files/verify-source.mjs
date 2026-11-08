import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySessionEngineBoundaryPatches, composeSessionEnginePatchManifests }
  from '../../../packaging/session-engine/patches.mjs'

// Bounded static verification only: no package execution, compiler or test runner.
const repository = process.argv[2]
if (!repository) throw new Error('Pinned original source repository required')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const commit = '25bf84ab07f53f141c20239c63e383823a9d5ea0'
const git = args => execFileSync('git', ['--no-replace-objects', '-C', repository, ...args],
  { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
const cache = new Map()
const original = { identity: { commit }, files: git(['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n'),
  read: file => {
    if (!cache.has(file)) cache.set(file, git(['show', `${commit}:${file}`]))
    return cache.get(file)
  } }
const families = [
  ['state', 'packaging/session-engine/boundary-patches.json'],
  ['client-connection', 'patches/t3-session/client-connection/boundary-patches.json'],
  ['extraction', 'patches/t3-session/extraction/boundary-patches.json'],
  ['files', 'patches/t3-session/files/boundary-patches.json'],
  ['request-privacy', 'patches/t3-session/requests/boundary-patches.json'],
].map(([id, file]) => ({ id, bytes: readFileSync(resolve(root, file)) }))
const manifest = composeSessionEnginePatchManifests(original, families)
const snapshot = applySessionEngineBoundaryPatches(original, manifest)
const own = JSON.parse(families.find(family => family.id === 'files').bytes)
const paths = [...new Set(own.patches.map(patch => patch.file))]
const output = resolve(root, '.artifacts/t14-source-check', randomUUID())
const hashes = {}
for (const path of paths) {
  const bytes = snapshot.read(path)
  const file = resolve(output, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes, { flag: 'wx' })
  execFileSync(process.execPath, ['--max-old-space-size=128', '--experimental-transform-types', '--check', file],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  hashes[path] = createHash('sha256').update(bytes).digest('hex')
}
const evidence = { kind: 'static-source-only', commit, patchedFiles: hashes,
  manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  runtimeExecuted: false, typechecked: false, authorityQualified: false }
writeFileSync(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${JSON.stringify({ ...evidence, output })}\n`)
