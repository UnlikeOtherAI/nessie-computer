import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openInferenceResourceIdentity } from '../src/inference-resource-identity.js'

test('cloud key publication uses native CAS once and requires barrier on every open', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-resource-key-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let mutations = 0, barriers = 0
  const cloud = { mutate: async (path: string, input: { operation: string; bytes?: Uint8Array;
    expectedDigest: string | null }) => {
    mutations++
    assert.equal(input.operation, 'replace')
    assert.equal(input.expectedDigest, null)
    await writeFile(path, input.bytes!, { flag: 'wx', mode: 0o600 })
  }, barrier: async () => { barriers++; throw new Error('Barrier outcome unknown') } }
  await assert.rejects(openInferenceResourceIdentity(directory, {}, cloud), /Barrier outcome unknown/)
  const original = await readFile(join(directory, 'resource-key.json'))
  await assert.rejects(openInferenceResourceIdentity(directory, {}, cloud), /Barrier outcome unknown/)
  assert.equal(mutations, 1)
  assert.equal(barriers, 2)
  assert.deepEqual(await readFile(join(directory, 'resource-key.json')), original)
  assert.deepEqual(await readdir(directory), ['resource-key.json'])
})
