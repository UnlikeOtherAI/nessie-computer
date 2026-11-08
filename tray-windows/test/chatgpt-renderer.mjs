import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

export const verifyChatgptLocales = async (browser, ui, output, files) => {
  let proofs = 0
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
        await page.locator('#ai-chatgpt-list button').first().click()
        await page.waitForFunction(() => window.calls.some(call => call.command === 'executor_personal_chatgpt'))
        assert.equal(await page.locator('#chatgpt-start').isDisabled(), true)
        await page.locator('#chatgpt-restriction').check()
        await page.locator('#chatgpt-start').focus()
        await page.keyboard.press('Enter')
        await page.locator('#chatgpt-background').waitFor()
        assert.equal(await page.locator('#chatgpt-background').textContent(), await page.evaluate(() => window.chatgptConsoleWords.backgroundOn))
        await page.locator('#chatgpt-background').click()
        await page.waitForFunction(() => window.chatgptProfile.backgroundConsentRevision === 1)
        await page.locator('#chatgpt-background').click()
        await page.waitForFunction(() => window.chatgptProfile.backgroundConsentRevision === null)
        await page.locator('#chatgpt-background').click()
        await page.waitForFunction(() => window.chatgptProfile.backgroundConsentRevision === 2)
        const writes = await page.evaluate(() => window.calls.filter(call => call.command === 'executor_personal_chatgpt'
          && call.args.operation.operation === 'background-consent').map(call => call.args))
        assert.deepEqual(writes.map(write => [write.operation.enabled, write.operation.expectedRevision]),
          [[true, null], [false, 1], [true, null]])
        assert.ok(writes.every(write => write.executorId === 'team-0'))
        assert.equal(await page.locator('#chatgpt-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true)
        assert.ok((await page.locator('#chatgpt-background').boundingBox()).height >= 44)
        await page.screenshot({ path: join(output, `${host}-chatgpt-${locale}-${width}.png`), fullPage: true })
        await page.locator('#chatgpt-close').click()
        const afterClose = await page.evaluate(() => window.calls.filter(call =>
          call.command === 'executor_personal_chatgpt' && ['cancel', 'disconnect'].includes(call.args.operation.operation)))
        assert.deepEqual(afterClose, [], 'closing does not cancel sign-in or clear credential custody')
        assert.deepEqual(errors, [])
        await context.close()
        proofs += 1
      }
    }
  }
  process.stdout.write(`ChatGPT console: ${proofs} locale/width/host journeys passed.\n`)
}
