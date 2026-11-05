import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = async (directory) => JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
const packages = [root, ...await Promise.all((await readdir(join(root, 'packages')))
  .map((name) => join(root, 'packages', name)))]

test('the public workspace contains every internal runtime dependency', async () => {
  const manifests = await Promise.all(packages.map(manifest))
  const names = new Set(manifests.map((value) => value.name))
  for (const value of manifests) for (const [name, version] of Object.entries(value.dependencies ?? {})) {
    assert.ok(!['@nessie/runtime', '@nessie/db', '@nessie/schemas'].includes(name), `${value.name} imports ${name}`)
    if (version.startsWith('workspace:')) assert.ok(names.has(name), `${value.name} needs absent ${name}`)
    assert.doesNotMatch(version, /git\+|github:|git@|https:\/\/github\.com\//u, `${name} requires a Git checkout`)
  }
})

test('public source verification has no Prisma or private-package preflight', async () => {
  const value = await manifest(root)
  assert.equal(value.license, 'FSL-1.1-ALv2')
  assert.equal(value.repository.url, 'git+https://github.com/UnlikeOtherAI/nessie-executor.git')
  assert.doesNotMatch(JSON.stringify(value.scripts), /prisma|DEEP_AGENT_READ_TOKEN|REMEMBER_READ_TOKEN/u)
  const licence = await readFile(join(root, 'LICENSE'), 'utf8')
  assert.match(licence, /FSL-1\.1-ALv2/u)
  assert.match(licence, /second anniversary/u)
})
