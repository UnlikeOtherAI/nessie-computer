// Local headless renderer test only; mocked proposals do not prove native consent.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const root = new URL('../../packages/executor-console/', import.meta.url)
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url.slice(1)
  if (!['index.html', 'style.css', 'retained-import.js', 'retained-import-words.json'].includes(name)) {
    response.writeHead(404).end(); return
  }
  let bytes = await readFile(new URL(name, root))
  if (name === 'index.html') bytes = bytes.toString().replace(/<script[^>]*src="(?!retained-import\.js)[^"]*"[^>]*><\/script>/gu, '')
  response.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json')
    ? 'application/json' : name.endsWith('.css') ? 'text/css' : 'text/html')
  response.end(bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.T3_CONSOLE_BROWSER_EXECUTABLE, headless: true })
try {
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.calls = []
    window.active = false
    window.fail = false
    window.executorNative = { platform: 'windows', invoke: async (command, args) => {
      window.calls.push({ command, args })
      if (window.fail) throw new Error('refused')
      if (command === 'executor_retained_action') {
        window.active = args.action === 'approve'; return { status: 'locally-approved-awaiting-consumer' }
      }
      return { roots: [{ admittedRootKey: 'fixture' }], active: window.active,
        pending: { enrollments: [], imports: [{ challengeId: 'fixture-challenge', environmentId: 'original-env',
          recipient: { subject: 'uoa:recipient', organizationId: 'uoa:org', teamId: 'uoa:team' },
          selection: { kind: 'threads', threadIds: ['b', 'a'], projectIds: ['p2', 'p1'] } }] } }
    } }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate(() => {
    document.getElementById('tab-settings').hidden = false
    document.getElementById('team-row').hidden = false
    const option = document.createElement('option'); option.value = 'fixture-executor'; option.textContent = 'Fixture team'
    document.getElementById('connection').append(option)
  })
  await page.locator('#retained-import:not([hidden])').waitFor()
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'display must not auto-approve or auto-fetch')
  await page.getByRole('button', { name: 'Refresh requests' }).click()
  await page.getByRole('button', { name: 'Review T3 import', exact: true }).waitFor()
  const text = await page.locator('#retained-requests').innerText()
  assert.ok(text.indexOf('"b"') < text.indexOf('"a"') && text.includes('not_attested_by_original_source'))
  await page.getByRole('button', { name: 'Review T3 import', exact: true }).click()
  await page.getByText('Local approval is active until expiry or Stop.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Stop local approval' }).click()
  await page.locator('#retained-revoke[hidden]').waitFor({ state: 'attached' })
  await page.evaluate(() => { window.fail = true })
  await page.getByRole('button', { name: 'Refresh requests' }).click()
  await page.locator('#retained-error:not([hidden])').waitFor()
  assert.ok((await page.evaluate(() => window.calls)).every(c => !c.command.includes('commit')))
  if (process.env.T3_CONSOLE_CAPTURE_PATH) await page.screenshot({ path: process.env.T3_CONSOLE_CAPTURE_PATH })
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
