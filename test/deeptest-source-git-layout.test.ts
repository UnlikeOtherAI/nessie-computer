import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { assertDeepTestGitLayout, DeepTestGitLayoutError } from '../src/deeptest-source-git-layout.js'
import { createDeepTestSourceSnapshot } from '../src/deeptest-source-snapshot.js'

const execute = promisify(execFile)

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-source-layout-'))
  const root = join(directory, 'repo')
  const outside = join(directory, 'outside')
  await mkdir(join(root, '.git', 'objects'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n')
  return { directory, outside, root }
}

const cleanup = async (directory: string) => {
  const parent = await realpath(tmpdir())
  const target = await realpath(directory)
  assert.equal(dirname(target), parent)
  assert.equal(target.startsWith(join(parent, 'nessie-source-layout-')), true)
  await rm(target, { force: true, recursive: true })
}

test('Git configuration includes and shared metadata are rejected before any Git command', async () => {
  for (const entry of ['config', 'commondir', 'objects/info/alternates']) {
    const { directory, root } = await fixture()
    try {
      await mkdir(dirname(join(root, '.git', entry)), { recursive: true })
      await writeFile(join(root, '.git', entry), entry === 'config'
        ? '[include]\npath = /outside/config\n'
        : '/outside/objects\n')
      let gitCalls = 0
      await assert.rejects(() => assertDeepTestGitLayout(root, async () => {
        gitCalls += 1
        return join(root, '.git')
      }), DeepTestGitLayoutError)
      assert.equal(gitCalls, 0, entry)
    } finally {
      await cleanup(directory)
    }
  }
})

for (const entry of ['HEAD', 'refs', 'packed-refs', 'shallow', 'objects/aa']) {
  test(`a ${entry} metadata link is rejected before any Git command`, async (context) => {
    const { directory, outside, root } = await fixture()
    try {
      const isDirectory = entry === 'refs' || entry === 'objects/aa'
      const target = isDirectory ? outside : join(outside, 'ref')
      if (!isDirectory) await writeFile(target, 'a'.repeat(40))
      try {
        await symlink(target, join(root, '.git', entry), isDirectory ? 'junction' : 'file')
      } catch (error) {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
          context.skip('This Windows host does not grant file-symlink creation; Linux CI checks it.')
          return
        }
        throw error
      }
      let gitCalls = 0
      await assert.rejects(() => assertDeepTestGitLayout(root, async () => {
        gitCalls += 1
        return join(root, '.git')
      }), DeepTestGitLayoutError)
      assert.equal(gitCalls, 0, entry)
    } finally {
      await cleanup(directory)
    }
  })
}

test('a local core.worktree setting cannot redirect snapshot source or working-tree inspection', async () => {
  const { directory, outside, root } = await fixture()
  try {
    const git = async (args: readonly string[]) => (await execute('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
      windowsHide: true,
    })).stdout
    await git(['init', '--quiet', '--template='])
    const source = 'export const authorised = true\n'
    await writeFile(join(root, 'source.ts'), source)
    await git(['add', '--', 'source.ts'])
    await git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '--quiet', '-m', 'Synthetic source fixture'])
    await writeFile(join(outside, 'source.ts'), 'export const outside = true\n')
    await git(['config', 'core.worktree', resolve(outside)])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    assert.equal(snapshot.working_tree_state, 'clean')
    assert.equal(snapshot.coverage.readable_files, 1)
    assert.equal(snapshot.files[0]?.path, 'source.ts')
    assert.equal(snapshot.files[0]?.content?.toString('utf8'), source)
    assert.equal(await readFile(join(outside, 'source.ts'), 'utf8'), 'export const outside = true\n')
  } finally {
    await cleanup(directory)
  }
})
