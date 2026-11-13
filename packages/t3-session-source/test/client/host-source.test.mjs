import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { applySessionEngineBoundaryPatches } from '../../../../packaging/session-engine/patches.mjs'

const root = resolve(import.meta.dirname, '../..')
const directory = resolve(root, '../../patches/t3-session/client-connection')
const manifest = JSON.parse(readFileSync(resolve(directory, 'host-patches.json')))
const repository = process.env.T3_CLIENT_CONNECTION_SOURCE_REPOSITORY ?? resolve(root, '.artifacts/source/upstream.git')
const files = [...new Set(manifest.patches.map(patch => patch.file))]
const original = new Map(files.map(file => [file, execFileSync('git', ['--no-replace-objects', '-C', repository,
  'show', `${manifest.sourceCommit}:${file}`], { maxBuffer: 4 * 1024 * 1024, windowsHide: true })]))
const snapshot = { identity: { commit: manifest.sourceCommit }, files, read: file => original.get(file) }
const url = JSON.parse(readFileSync(resolve(directory, 'boundary-patches.json')))
const combined = { ...manifest,
  patches: [...url.patches.filter(patch => files.includes(patch.file)), ...manifest.patches] }

test('host extraction preserves original bearer checks and both full and restricted resolution paths', () => {
  const patched = applySessionEngineBoundaryPatches(snapshot, Buffer.from(JSON.stringify(combined)))
  for (const file of files) {
    const output = patched.read(file).toString('utf8')
    stripTypeScriptTypes(output)
    const last = combined.patches.filter(patch => patch.file === file).at(-1)
    assert.equal(createHash('sha256').update(output).digest('hex'), last.afterSha256)
  }
  const bearer = manifest.patches[0].from
  assert.ok(patched.read(files[0]).toString('utf8').includes(bearer))
  assert.match(patched.read(files[1]).toString('utf8'), /Layer.effect\(ConnectionResolver, make\)/u)
  assert.match(patched.read(files[1]).toString('utf8'), /Layer.effect\(ConnectionResolver, makeBearer\)/u)
})
