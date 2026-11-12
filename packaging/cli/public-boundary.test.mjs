import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  assert.equal(value.repository.url, 'git+https://github.com/UnlikeOtherAI/nessie-computer.git')
  assert.doesNotMatch(JSON.stringify(value.scripts), /prisma|DEEP_AGENT_READ_TOKEN|REMEMBER_READ_TOKEN/u)
  const licence = await readFile(join(root, 'LICENSE'), 'utf8')
  assert.match(licence, /FSL-1\.1-ALv2/u)
  assert.match(licence, /second anniversary/u)
})

test('Unix entry points retain executable Git modes after extraction on Windows', () => {
  const entries = ['guest/kernel/build.sh', 'guest/works.nessie.executor.guest',
    'menubar-macos/scripts/build-app.sh', 'menubar-macos/scripts/test-app.sh', 'vm/scripts/build-guest-initrd.sh']
  const modes = new Map(execFileSync('git', ['ls-files', '--stage', '--', ...entries],
    { cwd: root, encoding: 'utf8' }).trim().split('\n').map(line => {
    const [metadata, path] = line.split('\t')
    return [path, metadata.split(' ')[0]]
  }))
  for (const path of entries) assert.equal(modes.get(path), '100755', `${path} must run after a Unix checkout`)
})
