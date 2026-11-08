import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { assertOutsideCheckout, resolveT3SessionStateDir } from '../../dist/t3-session/runtime/paths.js'
import { acquireSessionStateWriter } from '../../dist/t3-session/runtime/ownership.js'

const root = resolve(import.meta.dirname, '../..')

test('durable runtime state rejects relative paths and task checkouts before native security work', async () => {
  await assert.rejects(assertOutsideCheckout('relative'), { code: 'session_state_absolute_path_required' })
  await assert.rejects(resolveT3SessionStateDir(root, 'opaque:/environment:雪'), { code: 'session_state_inside_checkout' })
  await assert.rejects(acquireSessionStateWriter(root), { code: 'session_state_inside_checkout' })
})

test('the resolver detects linked worktree .git files and rejects unusable storage keys', async () => {
  const parent = join(root, '.artifacts/runtime-paths')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'run-'))
  await writeFile(join(directory, '.git'), 'gitdir: synthetic-owned-checkout')
  await assert.rejects(assertOutsideCheckout(join(directory, 'state')), { code: 'session_state_inside_checkout' })
  for (const key of ['', 'x'.repeat(4097)]) {
    await assert.rejects(resolveT3SessionStateDir(directory, key), { code: 'session_state_location_invalid' })
  }
})
