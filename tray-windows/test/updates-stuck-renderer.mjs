// The Mac's update helper stopped answering (8 November): the native host reports
// `update.helper_unavailable`. The Needs you strip and Settings must say updates
// are stuck and offer one action that restarts the helper. When macOS holds the
// helper back for approval it reports `update.approval_required` instead, and
// both places ask for approval with one button that opens Login Items. When
// macOS refused to register the helper (9 November) it reports
// `update.registration_failed` with macOS's reason, and both places say updates
// can't start, with that reason and one Try again that registers again.
// Real shared console; only the native answers are fixtures. Assertions only.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

const STATES = {
  stuck: { code: 'update.helper_unavailable', kind: 'updates', key: 'updates:restart',
    words: { need: 'updates.stuckNeed', status: 'updates.helperStuck', button: 'updates.restart' } },
  approval: { code: 'update.approval_required', kind: 'updates-approval', key: 'updates:approve',
    words: { need: 'updates.approval', status: 'updates.approval', button: 'updates.openLoginItems' } },
  registration: { code: 'update.registration_failed', kind: 'updates-registration', key: 'updates:retry',
    reason: 'Operation not permitted',
    words: { need: 'updates.cantStart', status: 'updates.cantStart', button: 'updates.tryAgain' } },
}

export const verifyUpdatesStuck = async (browser, ui, files) => {
  for (const state of Object.keys(STATES)) await verifyUpdatesState(browser, ui, files, state)
}

const verifyUpdatesState = async (browser, ui, files, name) => {
  const state = STATES[name]
  let journeys = 0
  for (const locale of ['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es']) {
    for (const width of [640, 440]) {
      const context = await browser.newContext({ viewport: { width, height: 680 }, locale })
      await installRendererHost(context, 'macos', { paired: 1 })
      await context.addInitScript(({ code, reason }) => Object.assign(window.updateStatus, {
        installedVersion: '', sourceCommit: '', phase: 'failed', canInstall: false, draining: false,
        notify: false, code, reason, availableVersion: undefined,
      }), { code: state.code, reason: state.reason })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('http://localhost:5875/**', async (route) => {
        const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
        const body = files.includes(file) ? await readFile(join(ui, file)).catch(() => '') : ''
        await route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript'
          : file.endsWith('.css') ? 'text/css' : 'text/html' })
      })
      await page.goto('http://localhost:5875')
      const words = await page.evaluate(({ keys, reason }) => Object.fromEntries(Object.entries(keys)
        .map(([name, key]) => [name, window.nc.t(key, { reason })])), { keys: state.words, reason: state.reason })
      for (const [key, value] of Object.entries(words)) assert.ok(value && !value.startsWith('updates.'), `${locale} ${key}`)
      if (state.reason) assert.ok(words.need.endsWith(state.reason), `${locale} names macOS's reason`)

      // The Needs you strip says it, with the one action, on whatever tab is open.
      const row = page.locator(`#needs-you-list .need-${state.kind}`)
      await row.waitFor()
      assert.equal(await page.locator('#needs-you-list .need').count(), 1, 'one line for the helper, never two')
      assert.equal(await row.locator('p').textContent(), words.need)
      assert.equal(await row.locator(`[data-key="${state.key}"]`).textContent(), words.button)
      assert.equal(await page.locator('#needs-you-list').evaluate((element) => element.scrollWidth <= element.clientWidth), true)

      // Settings: the same state, and the setup button becomes its one action.
      await page.getByRole('tab').last().click()
      await page.waitForFunction((text) => document.getElementById('update-status').textContent === text, words.status)
      assert.equal(await page.locator('#update-setup').isVisible(), true)
      assert.equal(await page.locator('#update-setup').textContent(), words.button)
      assert.equal(await page.locator('#update-policy').isVisible(), false)

      // The action reaches the native host; a helper that answers clears both places.
      await row.locator(`[data-key="${state.key}"]`).click()
      await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_update_setup'))
      await page.waitForFunction((kind) => !document.querySelector(`#needs-you-list .need-${kind}`), state.kind)
      await page.waitForFunction(() => document.getElementById('update-setup').hidden)
      assert.deepEqual(errors, [])
      journeys++
      await context.close()
    }
  }
  process.stdout.write(`Updates ${name} journeys passed: ${journeys}\n`)
}
