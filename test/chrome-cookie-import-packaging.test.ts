import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chromeExtensionIdForPublicKey,
  prepareChromeCookieImport,
} from '../scripts/prepare-chrome-cookie-import.mjs'

test('development packaging creates an isolated pinned extension and native host without registering either', {
  // The package is the macOS one: a POSIX shell launcher, zipped with /usr/bin/zip.
  skip: process.platform === 'win32' ? 'The Chrome cookie import package is built for macOS, with a POSIX launcher and /usr/bin/zip.' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-chrome-import-package-'))
  const output = join(root, 'output')
  const keyPath = join(root, 'development-public.der.base64')
  const entryPath = join(root, 'executor.js')
  const publicKey = Buffer.from('development public key only').toString('base64')
  await writeFile(keyPath, `${publicKey}\n`, { mode: 0o600 })
  await writeFile(entryPath, 'process.exit(0)\n', { mode: 0o700 })
  try {
    const prepared = await prepareChromeCookieImport({
      executorEntry: entryPath,
      executorNode: process.execPath,
      extensionPublicKeyPath: keyPath,
      mode: 'development',
      outputDirectory: output,
      stateRoot: join(root, 'executor-state'),
    })
    const manifest = JSON.parse(await readFile(join(prepared.extensionDirectory, 'manifest.json'), 'utf8'))
    const nativeHost = JSON.parse(await readFile(prepared.nativeHostManifestPath, 'utf8'))

    assert.equal(prepared.extensionId, chromeExtensionIdForPublicKey(publicKey))
    assert.equal(manifest.key, publicKey)
    assert.match(manifest.name, /Development/)
    assert.match(nativeHost.name, /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/)
    assert.deepEqual(nativeHost.allowed_origins, [`chrome-extension://${prepared.extensionId}/`])
    assert.equal(nativeHost.path, prepared.launcherPath)
    const launcher = await readFile(prepared.launcherPath, 'utf8')
    assert.match(launcher, /--state-root/)
    assert.match(launcher, /--development-local-api/)
    assert.match(launcher, new RegExp(`--extension-origin 'chrome-extension://${prepared.extensionId}/'`))
    assert.doesNotMatch(launcher, /state-dir/)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
