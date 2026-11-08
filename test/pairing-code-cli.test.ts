import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pairingUsesWindowsTray, runPairingCodeCli } from '../src/pairing-code-cli.js'
import { executorApi } from '../src/api-client.js'
import { loadPairingCode } from '../src/pairing-code-store.js'

test('pairing on Windows points an ordinary terminal at add or the app before touching local state', async (context) => {
  let output = ''
  context.mock.method(process.stdout, 'write', (chunk: string) => { output += chunk; return true })
  assert.equal(await runPairingCodeCli([], 'win32'), true)
  assert.equal(await runPairingCodeCli(['pair'], 'win32'), true)
  assert.equal(await runPairingCodeCli(['pairing-start'], 'win32'), true)
  assert.equal(output, 'Run nessie-computer add, or open Nessie Computer and choose Add this computer.\n'.repeat(3))
})

test('pairing keeps explicit operator state and JSON native commands on their configured path', () => {
  for (const args of [
    ['pair', '--state-dir', 'C:/operator/executor'],
    ['pair', '--cli'],
    ['pairing-start', '--json', '--pairing-input-stdin'],
    ['pairing-status', '--json'],
    ['pair', '--enrollment', 'existing-enrollment'],
  ]) assert.equal(pairingUsesWindowsTray(args, 'win32'), false)
  assert.equal(pairingUsesWindowsTray(['pair'], 'linux'), false)
  assert.equal(pairingUsesWindowsTray(['pair'], 'darwin'), false)
})

test('replacement never implicitly selects an existing account', async () => {
  await assert.rejects(runPairingCodeCli(['pair', '--replace'], 'linux'), /Choose the team to replace/)
})

test('pairing refuses a missing operator directory before falling back to a default pairing', async () => {
  await assert.rejects(runPairingCodeCli(['pair', '--state-dir'], 'win32'), /missing a required setting/)
  await assert.rejects(runPairingCodeCli(['pair', '--state-dir', '--json'], 'win32'), /missing a required setting/)
})

test('the CLI signs only the explicitly selected read-only operations before requesting approval', {
  skip: process.platform === 'win32' && 'owner-only state on Windows needs the packaged native helper',
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-read-only-pairing-'))
  const workspace = join(root, 'source')
  const directory = join(root, 'state')
  await mkdir(workspace)
  context.mock.method(process.stdout, 'write', () => true)
  context.mock.method(executorApi, 'pairing', async (_origin, action) => {
    assert.equal(action, 'start')
    return { pairingId: '00000000-0000-4000-8000-000000000001', code: '12345678',
      fingerprint: `sha256:${'a'.repeat(64)}`, expiresAt: '2099-01-01T00:00:00.000Z', pollIntervalSeconds: 3 }
  })
  try {
    assert.equal(await runPairingCodeCli(['pairing-start', '--api', 'nessie', '--json',
      '--state-dir', directory, '--workspace', workspace, '--operations', 'file.list,file.read'], 'linux'), true)
    assert.deepEqual((await loadPairingCode(directory))?.request.descriptor.descriptor.operationKeys,
      ['file.list', 'file.read'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Released native hosts still send `pairing-confirm` after the claim; it now answers as a status check.
test('pairing-confirm from a released native host is a status check, not a second consent', {
  skip: process.platform === 'win32' && 'owner-only state on Windows needs the packaged native helper',
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-pairing-confirm-'))
  let output = ''
  context.mock.method(process.stdout, 'write', (chunk: string) => { output += chunk; return true })
  try {
    assert.equal(await runPairingCodeCli([
      'pairing-confirm', '--json', '--state-dir', directory, '--claim-digest', `sha256:${'c'.repeat(64)}`,
    ], 'linux'), true)
  } finally {
    context.mock.restoreAll()
    await rm(directory, { recursive: true, force: true })
  }
  assert.deepEqual(JSON.parse(output), { status: 'idle' })
})
