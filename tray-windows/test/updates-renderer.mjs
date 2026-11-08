// Real shared console entry point and native transports; only the broker responses are fixtures.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

export const verifySoftwareUpdates = async (browser, ui, files, root) => {
  const before = process.argv.find((arg) => arg.startsWith('--updates-before='))?.split('=')[1]
  const copyOnly = process.argv.includes('--updates-copy-only')
  const bootstrapOnly = process.argv.includes('--updates-bootstrap-only')
  const setupOnly = process.argv.includes('--updates-setup-only')
  const output = join(root, copyOnly ? '.artifacts/executor-console-copy' : setupOnly ? '.artifacts/executor-console-setup'
    : bootstrapOnly ? '.artifacts/executor-console-bootstrap' : '.artifacts/executor-console-updates',
    before ? 'before' : 'after')
  await mkdir(output, { recursive: true })
  const resource = async (file) => before
    ? execFileSync('git', ['show', `${before}:packages/executor-console/${file}`], { cwd: root, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'ignore'] })
    : readFile(join(ui, file))
  let journeys = 0
  const open = async ({ host = 'windows', width = 640, locale = 'en-GB', state = 'idle' } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: 680 }, locale })
    await installRendererHost(context, host)
    await context.addInitScript((state) => {
      if (state === 'unavailable') window.updateUnavailable = true
      if (state !== 'idle') Object.assign(window.updateStatus, { availableVersion: '1.0.1', automatic: false })
      if (state === 'prompt') Object.assign(window.updateStatus, { phase: 'available', notify: true })
      else if (['downloading', 'waiting', 'installing', 'restarting'].includes(state)) {
        Object.assign(window.updateStatus, { phase: state, targetVersion: '1.0.1' })
      } else if (state === 'unsupported') Object.assign(window.updateStatus, { phase: state, canInstall: false })
      else if (state === 'bootstrap') Object.assign(window.updateStatus, {
        phase: 'failed', canInstall: false, code: 'update.bootstrap_required', availableVersion: undefined,
      })
      else if (state === 'setup') Object.assign(window.updateStatus, {
        installedVersion: '', sourceCommit: '', phase: 'unsupported', canInstall: false,
        code: 'update.setup_required', availableVersion: undefined,
      })
      else if (['available', 'failed'].includes(state)) window.updateStatus.phase = state
    }, state)
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Scripts outside the Software section's own files (the team tabs) are served empty: this journey is about updates.
    await page.route('http://localhost:5875/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      const body = files.includes(file) || before ? await resource(file).catch(() => '') : ''
      await route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript'
        : file.endsWith('.css') ? 'text/css' : 'text/html' })
    })
    await page.goto('http://localhost:5875')
    if (state === 'prompt' && (!before || copyOnly)) {
      // The native notification opens Settings before presenting the alert.
      await page.evaluate(() => window.emitTray('tray://section/settings'))
    } else await page.getByRole('tab').last().click() // Settings, in whichever language the page speaks
    if (!before || copyOnly) await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_update_control'))
    return { context, page, errors }
  }
  for (const host of setupOnly ? ['macos'] : ['windows', 'macos']) {
    for (const width of [640, 440]) {
      const states = copyOnly ? ['prompt', 'unavailable'] : setupOnly ? [before ? 'unavailable' : 'setup'] : bootstrapOnly ? ['bootstrap'] : before ? ['idle']
        : ['idle', 'available', 'prompt', 'downloading', 'waiting', 'installing',
        'restarting', 'failed', 'unsupported', 'unavailable']
      for (const state of states) {
        const { context, page, errors } = await open({ host, width, state })
        if (copyOnly && state === 'unavailable') await page.locator('#update-error').waitFor()
        if (copyOnly && state === 'prompt') await page.locator('#update-dialog[open]').waitFor()
        if (!before) {
          if (state === 'unavailable') await page.locator('#update-error').waitFor()
          else if (state === 'setup') await page.locator('#update-version').getByText('Version unavailable', { exact: true }).waitFor()
          else await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
          if (state === 'prompt') await page.locator('#update-dialog[open]').waitFor()
          assert.equal(await page.locator('#update-policy').isVisible(), !['unsupported', 'unavailable', 'bootstrap', 'setup'].includes(state))
          assert.equal(await page.locator('#update-install').isVisible(), ['available', 'failed', 'prompt'].includes(state))
          assert.equal(await page.locator('#update-install').isEnabled(), true)
          if (!['prompt'].includes(state)) {
            assert.equal(await page.locator('#software-updates').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
          }
        }
        await page.screenshot({ path: join(output, `${host}-${width}-${state}.png`), fullPage: true })
        if (!before && state === 'bootstrap') {
          await page.getByText('Finish current work and stop older copies of Nessie Computer. Update setup will then finish automatically.',
            { exact: true }).waitFor()
          await page.evaluate(() => {
            Object.assign(window.updateStatus, { phase: 'idle', canInstall: true, code: undefined })
            window.emitTray('executor://update-available')
          })
          await page.waitForFunction(() => document.getElementById('update-status').textContent === window.nc.t('updates.idle'))
          assert.equal(await page.locator('#update-policy').isVisible(), true)
        }
        if (!before && state === 'prompt') {
          await page.locator('#update-prompt-remind').click()
          await page.waitForFunction(() => !document.getElementById('update-dialog').open)
          assert.deepEqual(await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_update_control').at(-1).args),
            { request: { operation: 'remind' } })
          // A later version bypasses the old reminder and opens a fresh alert.
          await page.evaluate(() => {
            window.updateStatus.availableVersion = '1.0.2'
            window.updateStatus.notify = true
            window.emitTray('executor://update-available')
          })
          await page.locator('#update-prompt-body').getByText(/1\.0\.2/).waitFor()
          await page.locator('#update-prompt-install').click()
          await page.waitForFunction(() => !document.getElementById('update-dialog').open)
          await page.getByText('Downloading version 1.0.2…', { exact: true }).waitFor()
        }
        if (!before && ['available', 'failed'].includes(state)) {
          await page.locator('#update-install').click()
          await page.getByText('Downloading version 1.0.1…', { exact: true }).waitFor()
          assert.deepEqual(await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_update_control').at(-1).args),
            { request: { operation: 'install' } })
        }
        if (!before && state === 'idle') {
          await page.locator('#update-automatic').uncheck()
          await page.getByText('Automatic updates are off. Nessie will ask you when a new version is available.', { exact: true }).waitFor()
          await page.locator('#update-automatic').check()
          await page.waitForFunction(() => window.updateStatus.automatic)
        }
        if (!before && state === 'unavailable') {
          await page.evaluate(() => { window.updateUnavailable = false })
          await page.locator('#update-check').click()
          await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
          assert.equal(await page.locator('#update-error').isHidden(), true)
        }
        assert.deepEqual(errors, [])
        journeys++
        await context.close()
      }
    }
  }
  if (!before) {
    if (!copyOnly) for (const locale of ['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es']) {
      const { context, page, errors } = await open({ host: 'macos', width: 440, locale, state: 'setup' })
      await page.locator('#update-setup').waitFor()
      assert.equal(await page.locator('#update-policy').isVisible(), false)
      assert.equal(await page.locator('#update-check').isEnabled(), false)
      await page.screenshot({ path: join(output, `macos-440-setup-${locale}.png`), fullPage: true })
      await page.evaluate(() => { window.updateSetupDenied = true })
      await page.locator('#update-setup').click()
      await page.locator('#update-error').waitFor()
      assert.equal(await page.locator('#update-setup').isVisible(), true)
      await page.evaluate(() => { window.updateSetupDenied = false })
      await page.locator('#update-setup').click()
      await page.waitForFunction(() => document.getElementById('update-setup').hidden)
      assert.equal(await page.locator('#update-policy').isVisible(), true)
      assert.deepEqual(errors, [])
      journeys++
      await context.close()
    }
    if (!setupOnly) for (const locale of ['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es']) {
      const { context, page, errors } = await open({ locale, width: 440, state: bootstrapOnly ? 'bootstrap' : 'prompt' })
      if (bootstrapOnly) {
        await page.waitForFunction(() => document.getElementById('update-status').textContent === window.nc.t('updates.bootstrap'))
        assert.equal(await page.locator('#software-updates').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
        await page.screenshot({ path: join(output, `windows-440-bootstrap-${locale}.png`), fullPage: true })
        assert.deepEqual(errors, [])
        journeys++
        await context.close()
        continue
      }
      await page.locator('#update-dialog[open]').waitFor()
      assert.equal(await page.locator('#update-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true)
      assert.ok((await page.locator('#update-prompt-install').textContent()).includes('1.0.1'))
      assert.equal(await page.locator('#update-prompt-remind').evaluate((button) => {
        const rect = button.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= innerHeight
      }), true)
      await page.screenshot({ path: join(output, `windows-440-prompt-${locale}.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.getElementById('update-dialog').open)
      assert.equal(await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_update_control').at(-1).args.request.operation), 'remind')
      assert.deepEqual(errors, [])
      journeys++
      await context.close()
    }
  }
  process.stdout.write(`${journeys} shared-console update journeys passed; screenshots ${output}\n`)
}
