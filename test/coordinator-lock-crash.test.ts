import { verifyInferenceTestState } from './fixtures/local-inference-security.js'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'

for (const boundary of ['before', 'recovery']) {
  test(`coordinator survives process crash ${boundary} mutation publication`, { timeout: 60_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'nessie-coordinator-lock-'))
    t.after(async () => { await rm(directory, { recursive: true, force: true }) })
    if (boundary === 'recovery') await writeFile(join(directory, 'mutation.lock'), JSON.stringify({
      version: 1, pid: 2147483647, startedAt: '10', token: randomUUID(),
    }), { mode: 0o600 })
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(
      './fixtures/coordinator-lock-crash-child.mjs', import.meta.url)), directory, boundary], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    })
    const ended = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
    try {
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
      assert.equal((await lines.next()).value, 'crash-boundary')
      child.kill('SIGKILL')
      await ended
      const coordinator = await LocalInferenceCoordinator.open({ directory,
        security: process.platform === 'win32' ? { helper: verifyInferenceTestState } : {} })
      assert.ok(await coordinator.acquire())
    } finally { child.kill(); await ended }
  })
}
