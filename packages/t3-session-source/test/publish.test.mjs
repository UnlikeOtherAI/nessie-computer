import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { publishSessionPackage } from '../publish.mjs'

const fixture = async () => {
  const parent = resolve(import.meta.dirname, '../.artifacts/publication')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'run-'))
  const dist = resolve(root, 'dist'), output = resolve(root, '.artifacts/package-builds', randomUUID())
  await mkdir(dist)
  await mkdir(output, { recursive: true })
  await writeFile(resolve(dist, 'generation.txt'), 'previous complete package')
  await writeFile(resolve(output, 'generation.txt'), 'new complete package')
  return { root, dist, output }
}
const failure = code => Object.assign(new Error(`synthetic ${code}`), { code })
const contents = path => readFile(resolve(path, 'generation.txt'), 'utf8')

test('a transient Windows directory lock recovers through the same publication and retains the previous generation',
  async () => {
    const f = await fixture()
    let attempts = 0
    await publishSessionPackage(f.root, f.output, { platform: 'win32', renameDirectory: async (from, to) => {
      if (from === f.dist && ++attempts === 1) throw failure('EPERM')
      return rename(from, to)
    } })
    assert.equal(attempts, 2)
    assert.equal(await contents(f.dist), 'new complete package')
    const [previous] = (await readdir(resolve(f.root, '.artifacts/package-builds')))
      .filter(name => name.startsWith('previous-'))
    assert.equal(await contents(resolve(f.root, '.artifacts/package-builds', previous)), 'previous complete package')
  })

test('a transient lock on the completed generation does not cause rollback or per-file publication', async () => {
  const f = await fixture()
  let attempts = 0
  await publishSessionPackage(f.root, f.output, { platform: 'win32', renameDirectory: async (from, to) => {
    if (from === f.output && ++attempts === 1) throw failure('EBUSY')
    return rename(from, to)
  } })
  assert.equal(attempts, 2)
  assert.equal(await contents(f.dist), 'new complete package')
})

test('publication failure restores the complete old output and preserves the failed new generation', async () => {
  const f = await fixture()
  await assert.rejects(publishSessionPackage(f.root, f.output, { renameDirectory: async (from, to) => {
    if (from === f.output) throw failure('ENOSPC')
    return rename(from, to)
  } }), { code: 'ENOSPC' })
  assert.equal(await contents(f.dist), 'previous complete package')
  assert.equal(await contents(f.output), 'new complete package')
})

test('non-Windows permission refusal is immediate and preserves both generations', async () => {
  const f = await fixture()
  let attempts = 0
  await assert.rejects(publishSessionPackage(f.root, f.output, { platform: 'linux', renameDirectory: async () => {
    attempts++
    throw failure('EPERM')
  } }), { code: 'EPERM' })
  assert.equal(attempts, 1)
  assert.equal(await contents(f.dist), 'previous complete package')
  assert.equal(await contents(f.output), 'new complete package')
})

test('publication refuses an output outside the package generation directory before moving anything', async () => {
  const f = await fixture()
  let attempts = 0
  await assert.rejects(publishSessionPackage(f.root, f.dist, { renameDirectory: async () => { attempts++ } }),
    /SESSION_PACKAGE_GENERATION_PATH_REFUSED/u)
  assert.equal(attempts, 0)
  assert.equal(await contents(f.dist), 'previous complete package')
})

test('a persistent Windows lock ends within the finite retry window and preserves both generations', async () => {
  const f = await fixture()
  const started = performance.now()
  let attempts = 0
  await assert.rejects(publishSessionPackage(f.root, f.output, { platform: 'win32', renameDirectory: async () => {
    attempts++
    throw failure('EPERM')
  } }), { code: 'EPERM' })
  assert.ok(attempts > 1)
  assert.ok(performance.now() - started < 10_000)
  assert.equal(await contents(f.dist), 'previous complete package')
  assert.equal(await contents(f.output), 'new complete package')
})

test('a failed rollback retains both complete generations and reports both errors', async () => {
  const f = await fixture()
  await assert.rejects(publishSessionPackage(f.root, f.output, { renameDirectory: async (from, to) => {
    if (from === f.output) throw failure('ENOSPC')
    if (to === f.dist) throw failure('EIO')
    return rename(from, to)
  } }), error => error instanceof AggregateError && error.message === 'SESSION_PACKAGE_RESTORE_FAILED'
    && error.errors[0].code === 'ENOSPC' && error.errors[1].code === 'EIO')
  assert.equal(await contents(f.output), 'new complete package')
  const [previous] = (await readdir(resolve(f.root, '.artifacts/package-builds')))
    .filter(name => name.startsWith('previous-'))
  assert.equal(await contents(resolve(f.root, '.artifacts/package-builds', previous)), 'previous complete package')
})
