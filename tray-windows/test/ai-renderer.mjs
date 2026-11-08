import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

export const verifyAiConnections = async (browser, ui, output, files) => {
  for (const host of ['windows', 'macos']) {
    for (const locale of ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']) {
      for (const width of [390, 1280]) {
        const context = await browser.newContext({ locale, viewport: { width, height: 800 } })
        await installRendererHost(context, host, { paired: true })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.route('http://localhost:5875/**', async route => {
          const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
          assert.ok(files.includes(file), file)
          await route.fulfill({ body: await readFile(join(ui, file)), contentType: file.endsWith('.js')
            ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
        })
        await page.goto('http://localhost:5875/')
        await page.getByRole('button', { name: 'AI · UnlikeOtherAI / Platform', exact: true }).click()
        assert.deepEqual(await page.locator('[role=tab]').evaluateAll(nodes => nodes.map(node => node.dataset.tab)),
          ['teams', 'folders', 'commands', 'sync', 'ai', 'settings'])
        assert.equal(await page.locator('h1').evaluate(node => getComputedStyle(node).userSelect), 'none')
        await page.locator('#ai-chatgpt-list button').waitFor()
        await page.screenshot({ path: join(output, `${host}-ai-empty-${locale}-${width}.png`), fullPage: true })
        for (const name of ['Personal', 'Work']) {
          await page.locator('#ai-add-chatgpt').click()
          await page.locator('#chatgpt-name').fill(name)
          assert.equal(await page.locator('#chatgpt-name').evaluate(node => getComputedStyle(node).userSelect), 'text')
          await page.locator('#chatgpt-restriction').check()
          await page.locator('#chatgpt-start').click()
          await page.locator('#chatgpt-background').waitFor()
          await page.locator('#chatgpt-close').click()
          await page.locator('#ai-chatgpt-list button').filter({ hasText: new RegExp('.') }).last().waitFor()
          assert.match(await page.locator('#ai-chatgpt-list').textContent(), new RegExp(name))
        }
        const ids = await page.evaluate(() => window.calls.filter(call => call.command === 'executor_personal_chatgpt'
          && call.args.operation.newProfileId).map(call => call.args.operation.newProfileId))
        assert.equal(new Set(ids).size, 2)
        assert.equal(await page.evaluate(() => window.chatgptProfiles.filter(profile => profile.phase === 'ready').length), 2)
        for (const [name, address, scope] of [['Strata', 'http://127.0.0.1:8080/v1', 'local'],
          ['Lab', 'http://192.168.1.90:8080/v1', 'network']]) {
          await page.locator('#ai-add-endpoint').click()
          await page.locator('#endpoint-name').fill(name)
          await page.locator('#endpoint-address').fill(address)
          await page.locator('#endpoint-scope').selectOption(scope)
          await page.locator('#endpoint-key').fill('test-only-key')
          await page.locator('#endpoint-save').click()
          await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
          await page.locator('#ai-endpoint-list button').last().waitFor()
          assert.match(await page.locator('#ai-endpoint-list').textContent(), new RegExp(name))
        }
        await page.screenshot({ path: join(output, `${host}-ai-connections-${locale}-${width}.png`), fullPage: true })
        await page.locator('#ai-endpoint-list button').last().click()
        assert.equal(await page.locator('#endpoint-key').inputValue(), '')
        assert.equal(await page.locator('#endpoint-clear-key-row').isVisible(), true)
        await page.screenshot({ path: join(output, `${host}-ai-endpoint-${locale}-${width}.png`), fullPage: true })
        await page.locator('#endpoint-remove').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        assert.equal(await page.evaluate(() => window.endpoints.length), 1)
        assert.equal(await page.evaluate(() => window.endpoints[0].name), 'Strata')
        await page.evaluate(() => { window.endpointOffline = true })
        await page.locator('#ai-refresh').click()
        await page.waitForFunction(() => document.querySelector('#ai-endpoint-list').textContent === window.aiConsoleWords.failed)
        await page.evaluate(() => { window.endpointOffline = false })
        await page.locator('#ai-refresh').click()
        await page.locator('#ai-endpoint-list button').waitFor()
        assert.equal(await page.locator('#tab-ai').evaluate(node => node.scrollWidth <= node.clientWidth), true)
        assert.deepEqual(errors, [])
        await context.close()
      }
    }
  }
  process.stdout.write('AI connections: multiple accounts, local/LAN endpoints, removal and recovery passed in seven locales.\n')
}
