// Local headless UI journey. Not part of CI or the ordinary package unit task.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { verifyPersonalPlanPairing } from './personal-pairing-renderer.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ui = join(root, 'packages/executor-console')
const output = join(root, '.artifacts/executor-personal-pairing')
const files = ['index.html', 'style.css', 'native.js', 'autosave.js', 'main.js', 'chatgpt-words.js', 'chatgpt.js',
  'teams.js', 'team-drafts.js', 'pairing-words.js', 'pairing.js', 'permissions.js',
  'sync-reasons-words.js', 'sync-words.js', 'sync.js']
const port = Number(process.env.NESSIE_EXECUTOR_CONSOLE_TEST_PORT ?? 5877)
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535)
const origin = `http://127.0.0.1:${port}`
const server = createServer(async (request, response) => {
  const name = new URL(request.url, origin).pathname.slice(1) || 'index.html'
  if (name === 'health') { response.setHeader('Content-Type', 'application/json'); response.end('{"ready":true}'); return }
  if (!files.includes(name)) { response.statusCode = 404; response.end(); return }
  try {
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript'
      : name.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(await readFile(join(ui, name)))
  } catch { response.statusCode = 500; response.end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
let browser
try {
  assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { ready: true })
  assert.ok((await (await fetch(origin)).text()).includes('pairing-personal-plan-choice'))
  process.stdout.write(`Console fixture healthy at ${origin}.\n`)
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) })
  await verifyPersonalPlanPairing(browser, ui, output, files, origin)
  process.stdout.write(`Screenshots: ${output}\n`)
} finally {
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
}
