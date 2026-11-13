import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scratch, sha256 } from './source-fixture.mjs'

// Separate scheduled fixture only. No change to executor/package.json or either workspace lock.
const directory = resolve(scratch, 'dependencies')
const producerLock = await readFile(new URL('../../packaging/session-engine/pnpm-lock.yaml', import.meta.url), 'utf8')
const integrity = 'sha512-d3Oah1WyKxFLFh19yWheS5IXIVaITzxZ71JkE1rkUozq/6EcJSU5nPk5bF2QrSygZ3SQoiNQB8TsxFriyMeMaQ=='
if (!producerLock.includes(`effect@4.1.2:\n    resolution: {integrity: ${integrity}}`)) {
  throw new Error('PINNED_PRODUCER_EFFECT_INTEGRITY_REQUIRED')
}
const manifest = JSON.stringify({
  name: 't19-actual-source-http-auth-fixture', private: true, type: 'module',
  packageManager: 'pnpm@10.22.0', dependencies: { effect: '4.1.2' },
}, null, 2) + '\n'
const lock = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n  .:\n    dependencies:\n      effect:\n        specifier: 4.1.2\n        version: 4.1.2\n\npackages:\n  effect@4.1.2:\n    resolution: {integrity: ${integrity}}\n\nsnapshots:\n  effect@4.1.2: {}\n`
await mkdir(directory, { recursive: true })
for (const [name, value] of [['package.json', manifest], ['pnpm-lock.yaml', lock]]) {
  const path = resolve(directory, name)
  const existing = await readFile(path, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing !== undefined && existing !== value) throw new Error('DEPENDENCY_INPUT_CONFLICT')
  if (existing === undefined) await writeFile(path, value, { flag: 'wx' })
}
console.log(JSON.stringify({
  directory, manifestSha256: sha256(manifest), lockSha256: sha256(lock), effectIntegrity: integrity,
  preparationScript: fileURLToPath(import.meta.url),
}))
