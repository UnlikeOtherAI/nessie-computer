import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('the verified coding bridge survives idle and follows normal shutdown; a named impostor does not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-coding-bridge-idle-'))
  try {
    // Its index.js is the fixture runtime's real entry; production derives trust from argv,
    // so this runs the actual generation and validation path in a separate process.
    const entry = fileURLToPath(new URL('./fixtures/coding-bridge-idle/index.js', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, directory], {
      encoding: 'utf8', timeout: 45_000, windowsHide: true,
    })
    assert.equal(result.status, 0, [result.error ?? '', result.stderr, result.stdout].join('\n'))
    assert.match(result.stdout, /same-process follow-up/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
