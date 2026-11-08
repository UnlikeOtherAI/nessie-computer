import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  ensureOwnerOnlyStateDirectory, assertOwnerOnlyStatePath, packagedNativeHelperPath,
} from '../src/state-security.js'
import { localUpdate } from '../src/updates/native-client.js'

const execute = promisify(execFile)

test('source Windows ACL checks do not claim installed update or credential authority',
  { skip: process.platform !== 'win32' }, async () => {
    assert.equal(process.env.NESSIE_EXECUTOR_PACKAGED_CLI, undefined)
    const directory = await mkdtemp(join(tmpdir(), 'nessie-source-acl-'))
    try {
      await ensureOwnerOnlyStateDirectory(directory)
      await assertOwnerOnlyStatePath(directory, 'directory')
      const status = await localUpdate({ operation: 'status' })
      assert.equal(status.phase, 'unsupported')
      assert.equal(status.canInstall, false)
      await assert.rejects(execute(packagedNativeHelperPath(), ['personal-state-context'],
        { windowsHide: true, timeout: 10_000, maxBuffer: 4096 }), (error: unknown) => {
        const reply = JSON.parse((error as { stdout: string }).stdout) as { status: string; code: string }
        assert.equal(reply.status, 'rejected')
        assert.match(reply.code, /^EXECUTOR_/u)
        return true
      })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
