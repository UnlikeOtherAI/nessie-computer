// Local-only actual browser import check. Never include browser execution in ordinary test/CI.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '../..')
const result = await build({ absWorkingDir: root, stdin: { contents: `
  import * as Contracts from '@nessie/t3-session-source/contracts';
  import * as Settings from '@nessie/t3-session-source/contracts/settings';
  import * as Relay from '@nessie/t3-session-source/contracts/relay';
  import * as Schema from 'effect/Schema';
  export const qualify = () => {
    const id = Schema.decodeUnknownSync(Contracts.ThreadId)('browser:opaque');
    const settings = Schema.decodeUnknownSync(Settings.ServerSettingsPatch)({ setModelsHidden: [] });
    const secret = ' \\r\\n synthetic\\u0000value 雪🔐 \\r\\n ';
    const decoded = Schema.decodeUnknownSync(Contracts.SecretRequestAnswerInput)({
      threadId: id, turnItemId: 'browser:request', answer: { type: 'save', secret } });
    const encoded = Schema.encodeSync(Contracts.SecretRequestAnswerInput)(decoded);
    if (encoded.answer.secret !== secret) throw Error('Browser codec changed value bytes');
    if (!Object.keys(Relay).length) throw Error('Relay exports absent');
    return { id, settings, relayExports: Object.keys(Relay).length, exactValueBytes: true };
  }`, resolveDir: root }, bundle: true, format: 'esm', platform: 'browser',
target: 'es2022', write: false, metafile: true })
const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll('\\', '/'))
assert.equal(inputs.some(path => path.endsWith('/engine.js') || path.includes('/@effect/platform-node')), false)
assert.ok(Object.values(result.metafile.outputs).every(output => output.imports.length === 0),
  'The actual browser module must have no Node builtins or unresolved external imports.')
const executablePath = process.env.T3_SESSION_BROWSER_EXECUTABLE ?? (process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path)) : undefined)
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const observed = await page.evaluate(async code => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    try { return (await import(url)).qualify() } finally { URL.revokeObjectURL(url) }
  }, result.outputFiles[0].text)
  assert.deepEqual(errors, [])
  assert.equal(observed.id, 'browser:opaque')
  assert.equal(observed.exactValueBytes, true)
  assert.ok(observed.relayExports > 0)
  console.log(JSON.stringify({ browser: browser.version(), headless: true, normalPackageEntries: true,
    engineOrNodeLeak: false, ...observed }))
} finally {
  await browser.close()
}
