import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { ensurePinnedSourceObject } from '../cache.mjs'

const git = (cwd, args) => execFileSync('git', ['--no-replace-objects', '-C', cwd, ...args], {
  stdio: 'pipe', windowsHide: true,
}).toString().trim()

test('interrupted fetch and later pinned objects recover in the same cache without network', async () => {
  const root = resolve(import.meta.dirname, '../.artifacts/cache-test')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(resolve(root, 'retry-'))
  const upstream = resolve(directory, 'upstream')
  await mkdir(upstream)
  git(upstream, ['init'])
  const commit = async text => {
    await writeFile(resolve(upstream, 'source.txt'), text)
    git(upstream, ['add', 'source.txt'])
    git(upstream, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic source'])
    return git(upstream, ['rev-parse', 'HEAD'])
  }
  const first = await commit('one')
  const repository = resolve(directory, 'cache.git')
  await assert.rejects(ensurePinnedSourceObject({ repository, upstream: resolve(directory, 'unavailable'), commit: first }))
  await writeFile(resolve(repository, 'failed-work-item'), 'preserve')
  await ensurePinnedSourceObject({ repository, upstream, commit: first })
  assert.equal(git(repository, ['cat-file', '-t', first]), 'commit')
  // Cached exact object does not touch even an unavailable upstream.
  await ensurePinnedSourceObject({ repository, upstream: resolve(directory, 'unavailable'), commit: first })
  const second = await commit('two')
  await assert.rejects(ensurePinnedSourceObject({ repository, upstream: resolve(directory, 'unavailable'), commit: second }))
  await ensurePinnedSourceObject({ repository, upstream, commit: second })
  assert.equal(git(repository, ['cat-file', '-t', first]), 'commit')
  assert.equal(git(repository, ['cat-file', '-t', second]), 'commit')
  assert.equal(await readFile(resolve(repository, 'failed-work-item'), 'utf8'), 'preserve')
  const blob = git(upstream, ['rev-parse', 'HEAD:source.txt'])
  await assert.rejects(ensurePinnedSourceObject({ repository, upstream, commit: blob }), /CONTRACT_COMMITTED_OBJECT_REQUIRED/)
})
