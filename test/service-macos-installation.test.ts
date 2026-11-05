import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyMacServiceInstallation } from '../src/service-macos-installation.js'

const POSIX_ONLY = process.platform === 'win32' ? 'Homebrew uses POSIX paths and symlinks' : false

test('Homebrew service binds the running bundle to its installation and verifies the pinned Developer ID',
  { skip: POSIX_ONLY }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessie-brew-install-'))
    try {
      const cellar = join(root, 'Cellar/nessie-executor/1.0.0')
      const runtime = join(cellar, 'libexec/runtime')
      await mkdir(runtime, { recursive: true })
      await mkdir(join(cellar, 'bin'))
      await mkdir(join(root, 'opt'))
      await symlink(cellar, join(root, 'opt/nessie-executor'))
      const launcher = join(root, 'opt/nessie-executor/bin/nessie-executor')
      await writeFile(launcher, '#!/bin/sh')
      const node = 'nessie-executor-runtime'
      const hashes: Record<string, string> = {}
      for (const name of [node, 'nessie-executor.cjs', 'nessie-executor-native', 'NODE_LICENSE']) {
        await writeFile(join(runtime, name), name)
        hashes[name] = createHash('sha256').update(name).digest('hex')
      }
      await writeFile(join(runtime, 'manifest.json'), JSON.stringify({
        format: 1, nodeVersion: '22.23.3', nodeExecutable: node, nodeSha256: hashes[node],
        executorBundleSha256: hashes['nessie-executor.cjs'],
        nativeHelper: 'nessie-executor-native', nativeHelperSha256: hashes['nessie-executor-native'],
      }))
      const options = { node: join(runtime, node), bundle: join(runtime, 'nessie-executor.cjs'), team: 'ABCDEFGHIJ' }
      const verified: string[] = []
      const run = async (file: string, args: string[]) => {
        assert.equal(file, '/usr/bin/codesign')
        assert.deepEqual(args.slice(0, 3), ['--verify', '--strict', '-R'])
        assert.match(args[3]!, /anchor apple generic/)
        assert.match(args[3]!, /subject\.OU\] = "ABCDEFGHIJ"/)
        assert.match(args[3]!, /1\.2\.840\.113635\.100\.6\.1\.13/)
        verified.push(args[4]!)
        return { code: 0, stdout: '' }
      }
      await verifyMacServiceInstallation(launcher, run, options)
      assert.equal(verified.length, 2)
      await assert.rejects(verifyMacServiceInstallation(launcher, run, { ...options, team: '' }), /signed Homebrew/)
      for (const paths of [{ node: launcher }, { bundle: launcher }]) {
        await assert.rejects(verifyMacServiceInstallation(launcher, run, { ...options, ...paths }), /signed Homebrew/)
      }
      await assert.rejects(verifyMacServiceInstallation('/tmp/arbitrary', run, options), /signed Homebrew/)
      await assert.rejects(verifyMacServiceInstallation(launcher, async () => ({ code: 1, stdout: '' }), options), /not signed/)
      await writeFile(options.bundle, 'altered bundle')
      await assert.rejects(verifyMacServiceInstallation(launcher, run, options), /bundle does not match/)
      assert.equal(verified.length, 2, 'refusals must not proceed to signature checks')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
