import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executorApi } from '../src/api-client.js'
import { run } from '../src/cli.js'
import { acquireExecutorProcessLease } from '../src/process-lease.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

test('the legacy CLI refuses a concurrent pairing writer before reading or changing preparation', {
  skip: WINDOWS_STATE_HELPER_SKIP,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-legacy-pair-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  await ensureOwnerOnlyStateDirectory(directory)
  const lease = await acquireExecutorProcessLease(directory, 'pairing-operation.pid')
  const journal = join(directory, 'executor-pairing.json')
  await writeFile(journal, 'retained preparation')
  t.mock.method(executorApi, 'submitEnrollment', async () => assert.fail('Busy pairing must not contact the server'))
  try {
    await assert.rejects(run(['pair', '--api', 'https://api.example.test', '--enrollment',
      '00000000-0000-4000-8000-000000000601', '--challenge', 'opaque-challenge',
      '--state-dir', directory, '--workspace', root]), /Pairing is busy/u)
    assert.equal(await readFile(journal, 'utf8'), 'retained preparation')
  } finally { await lease.release() }
})
