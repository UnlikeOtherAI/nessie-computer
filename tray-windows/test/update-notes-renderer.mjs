import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

export async function verifyUpdateNotes(browser, ui, root, output) {
  const before = process.argv.find(arg => arg.startsWith('--notes-before='))?.split('=')[1]
  if (output) await mkdir(output, { recursive: true })
  for (const width of [640, 390]) {
    for (const locale of ['en-GB', 'en-US', 'cs', 'de', 'fr', 'it', 'es']) {
      const context = await browser.newContext({ viewport: { width, height: 680 }, locale })
      await installRendererHost(context, 'windows', { paired: 1 })
      await context.addInitScript(() => {
        Object.assign(window.updateStatus, { phase: 'available', availableVersion: '1.0.2', notify: true, automatic: false })
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('http://localhost:5875/**', async route => {
        const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
        const body = before ? execFileSync('git', ['show', `${before}:packages/executor-console/${file}`], { cwd: root })
          : await readFile(join(ui, file))
        await route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript'
          : file.endsWith('.css') ? 'text/css' : 'text/html' })
      })
      let requests = 0
      let fail = true
      const release = (tag, body, extra = {}) => ({ tag_name: tag, body, immutable: true, prerelease: false, ...extra })
      await page.route('https://api.github.com/**', async route => {
        requests++
        assert.equal(route.request().headers().cookie, undefined)
        if (fail) return route.fulfill({ status: 503, body: '{}' })
        const first = new URL(route.request().url()).searchParams.get('page') === '1'
        const releases = first ? [release('executor-v1.0.2', '<img src=x onerror="alert(1)">\nA useful change.\n'.repeat(60)),
          release('executor-v9.0.0', 'FUTURE'), release('executor-v1.0.0', 'ALREADY INSTALLED'),
          release('executor-v1.0.1', 'PREVIEW', { prerelease: true }),
          ...Array.from({ length: 6 }, () => release('update-catalog-stable', 'CATALOG'))]
          : [release('executor-v1.0.1', 'Earlier fix.')]
        return route.fulfill({ json: releases })
      })
      await page.goto('http://localhost:5875')
      await page.locator('#update-dialog[open]').waitFor()
      assert.equal(requests, 0, 'Notes are lazy')
      if (output && locale === 'en-GB') await page.screenshot({ path: join(output, `${width}-offer.png`) })
      if (!before) {
        await page.locator('#update-notes-toggle').click()
        await page.locator('#update-notes-retry').waitFor()
        fail = false
        await page.locator('#update-notes-retry').click()
        await page.locator('#update-notes-entries article').waitFor()
        assert.equal(await page.locator('#update-notes-entries img').count(), 0)
        assert.equal(await page.locator('#update-notes-entries').textContent().then(text => /FUTURE|INSTALLED|PREVIEW|CATALOG/.test(text)), false)
        assert.ok(await page.locator('#update-prompt-install').evaluate(button => button.getBoundingClientRect().bottom <= innerHeight))
        assert.ok(await page.locator('#update-dialog').evaluate(dialog => dialog.getBoundingClientRect().height <= innerHeight * 0.8 + 1))
        if (output && locale === 'en-GB') await page.screenshot({ path: join(output, `${width}-notes.png`) })
        await page.locator('#update-notes-more').click()
        await page.getByText('Earlier fix.', { exact: true }).waitFor()
        assert.equal(await page.locator('#update-notes-more').isHidden(), true)
        assert.equal(requests, 3)
        await page.locator('#update-notes-toggle').click()
        assert.equal(await page.locator('#update-notes-panel').isHidden(), true)
        await page.locator('#update-prompt-install').click()
        await page.waitForFunction(() => !document.getElementById('update-dialog').open)
        assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'executor_update_control').at(-1).args.request.operation), 'install')
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
  }
  process.stdout.write('Release-note journeys passed in seven locales at desktop and narrow widths.\n')
}
