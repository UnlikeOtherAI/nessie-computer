// Local-only rendered journey. Native protocol and installed GNOME checks are separate.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { stageLinuxConsole } from '../console/stage.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = resolve(process.env.LINUX_CONSOLE_SCREENSHOT_DIR ?? join(root, '.artifacts/linux-console'))
const resources = await mkdtemp(join(tmpdir(), 'nessie-console-'))
await stageLinuxConsole(root, resources)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) })
try {
  for (const width of [1280, 640, 390]) {
    const context = await browser.newContext({ locale: 'en-GB', viewport: { width, height: 680 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let state = { format: 1, installedVersion: '1.0.2', automatic: true, channel: 'stable',
      phase: 'idle', canInstall: true, notify: false }
    let fail = false
    const calls = []
    await page.exposeFunction('linuxFixtureUpdate', async message => {
      assert.equal(message.command, 'executor_update_control')
      assert.deepEqual(Object.keys(message.args), ['request'])
      const request = message.args.request
      calls.push(request)
      if (fail) throw new Error('unavailable')
      if (request.operation === 'automatic') state = { ...state, automatic: request.enabled }
      if (request.operation === 'check') state = { ...state, availableVersion: '1.0.3', phase: 'available', notify: true }
      if (request.operation === 'remind') state = { ...state, notify: false }
      if (request.operation === 'install') state = { ...state, phase: 'downloading', targetVersion: '1.0.3', notify: false }
      return state
    })
    await page.addInitScript(() => {
      window.webkit = { messageHandlers: { executor: { postMessage: message => {
        window.linuxFixtureUpdate(message).then(value => window.executorLinuxReply(message.id, value, false),
          () => window.executorLinuxReply(message.id, null, true))
      } } } }
    })
    const files = ['index.html', 'native.js', 'style.css', 'i18n.js', 'help.js', 'update-notes.js', 'updates.js', 'updates-words.js']
    await page.route('http://localhost:5878/**', async route => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      assert.ok(files.includes(file))
      await route.fulfill({ body: await readFile(join(resources, 'console', file)),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
    })
    await page.goto('http://localhost:5878/')
    await page.locator('#update-version').getByText('1.0.2', { exact: true }).waitFor()
    assert.equal(await page.locator('#update-automatic').isChecked(), true)
    const capture = name => page.screenshot({ path: join(output, name + '-' + width + '.png'), fullPage: true })
    await capture('current')
    await page.locator('#update-automatic').uncheck()
    // The explanation sits behind "?" beside the switch and follows it.
    await page.waitForFunction(() => document.querySelector('#update-hint .help-tip').textContent.startsWith('Automatic updates are off.'))
    await page.locator('#update-check').click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('button', { name: 'Remind me in 24 hours', exact: true }).waitFor()
    await page.getByText('Version 1.0.3 is available. Update now, or ask again in 24 hours.', { exact: true }).waitFor()
    await capture('offer')
    await page.locator('#update-prompt-remind').click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(calls.at(-1).operation, 'remind')
    await page.reload()
    await page.locator('#update-version').getByText('1.0.2', { exact: true }).waitFor()
    assert.equal(await page.locator('#update-automatic').isChecked(), false)
    assert.equal(await page.locator('#update-dialog').isVisible(), false)
    await capture('reminded')
    fail = true
    await page.locator('#update-check').click()
    await page.locator('#update-error').waitFor()
    await capture('service-unavailable')
    fail = false
    await page.locator('#update-check').click()
    await page.getByRole('dialog').waitFor()
    await page.locator('#update-prompt-install').click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByText('Downloading version 1.0.3…', { exact: true }).waitFor()
    assert.equal(calls.at(-1).operation, 'install')
    await capture('downloading')
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('Linux local software settings journey passed: ' + output)
} finally {
  await browser.close()
  await rm(resources, { recursive: true, force: true })
}
