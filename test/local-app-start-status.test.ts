import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLocalAppStartStatusWriter, readLocalAppStartStatus } from '../src/local-app-start-status.js'
import { withLocalAppStartStates, type LocalAppDescription } from '../src/local-mcp-apps.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/** `describe` reports a local app that keeps failing to start, from what the running daemon saved. */

const skip = WINDOWS_STATE_HELPER_SKIP

test('describe carries an enabled local app\'s failed starts, and nothing once they are forgotten', { skip },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessie-local-app-status-'))
    try {
      const stateDir = await ensureOwnerOnlyStateDirectory(join(root, 'team'))
      assert.equal((await readLocalAppStartStatus(stateDir)).size, 0, 'no status yet')
      const save = createLocalAppStartStatusWriter(stateDir)
      const retryAt = '2026-11-09T10:04:00.000Z'
      void save([{ name: 'kelpie', failures: 1, reason: 'handshake_failed' }])
      await save([{ name: 'kelpie', failures: 4, reason: 'handshake_failed', retryAt }])
      const apps: LocalAppDescription[] = [
        { name: 'kelpie', source: 'unlikeotherai', enabled: true, installed: true },
        { name: 'off', source: 'claude-code', enabled: false, installed: true, reason: 'switched_off' },
      ]
      const described = withLocalAppStartStates(apps, await readLocalAppStartStatus(stateDir))
      assert.deepEqual(described[0]?.start, { failures: 4, reason: 'handshake_failed', retryAt },
        'the last save wins')
      assert.equal(described[1]?.start, undefined)
      await save([])
      assert.deepEqual(withLocalAppStartStates(apps, await readLocalAppStartStatus(stateDir)), apps)
      await writeFile(join(stateDir, 'local-apps-status.json'), '{"version":1,"apps":[{"name":"x"', { mode: 0o600 })
      assert.equal((await readLocalAppStartStatus(stateDir)).size, 0, 'a damaged status reads as none')
    } finally { await rm(root, { force: true, recursive: true }) }
  })
