// Reach the opted-in Windows plan connection through the existing Add team dialog.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

export const verifyPersonalPlanPairing = async (browser, ui, output, files, origin) => {
  let proofs = 0
  for (const locale of ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']) {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ locale, viewport: { width, height: 800 } })
      await installRendererHost(context, 'windows')
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      if (!origin) await page.route('http://localhost:5875/**', async route => {
        const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
        assert.ok(files.includes(file), file)
        await route.fulfill({ body: await readFile(join(ui, file)), contentType: file.endsWith('.js')
          ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
      })
      await page.goto(origin ?? 'http://localhost:5875/')
      await page.getByRole('button', { name: 'Add team', exact: true }).click()
      assert.equal(await page.locator('#pairing-personal-plan').isChecked(), false)
      assert.ok((await page.locator('#pairing-personal-plan-label').textContent()).includes('ChatGPT'))
      await page.locator('#pairing-server').focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.id), 'pairing-personal-plan')
      await page.keyboard.press('Space')
      assert.equal(await page.locator('#pairing-personal-plan').isChecked(), true)
      assert.ok((await page.locator('#pairing-personal-plan-choice label').boundingBox()).height >= 44)
      assert.equal(await page.locator('#pair-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true)
      await page.screenshot({ path: join(output, `windows-personal-pairing-${locale}-${width}.png`), fullPage: true })
      await page.evaluate(() => { window.personalPairingFailure = 'Update Nessie Executor before connecting this plan.' })
      await page.locator('#pair-form [type=submit]').focus()
      await page.keyboard.press('Enter')
      await page.locator('#pairing-form-error').getByText('Update Nessie Executor before connecting this plan.').waitFor()
      assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'executor_pairing_start')
        .every(call => call.args.personalPlanConnection === true)), true, 'no interactive pairing after service refusal')
      await page.evaluate(() => { window.personalPairingFailure = null })
      await page.locator('#pair-form [type=submit]').click()
      await page.locator('#pairing-code').getByText('01234567').waitFor()
      await page.reload()
      await page.waitForFunction(() => window.calls.some(call => call.command === 'executor_pairing_status'))
      await page.getByRole('button', { name: 'Add team', exact: true }).click()
      await page.locator('#pairing-personal-plan').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#pairing-personal-plan').isChecked(), true)
      assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'executor_pairing_status')
        .every(call => call.args.personalPlanConnection === true)), true, 'restoration keeps the selected backend')
      await page.locator('#pair-form [type=submit]').click()
      await page.locator('#pairing-code').getByText('01234567').waitFor()
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.getElementById('pair-dialog').open)
      assert.equal(await page.evaluate(() => window.calls.find(call => call.command === 'executor_pairing_cancel')
        .args.personalPlanConnection), true)
      await page.getByRole('button', { name: 'Add team', exact: true }).click()
      await page.locator('#pairing-personal-plan').uncheck()
      await page.locator('#pair-form [type=submit]').click()
      await page.locator('#pairing-code').getByText('01234567').waitFor()
      assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'executor_pairing_start')
        .at(-1).args.personalPlanConnection), false, 'ordinary owner coding tools retain their default connection')
      assert.deepEqual(errors, [])
      await context.close()
      proofs += 1
    }
  }
  process.stdout.write(`Windows personal-plan pairing: ${proofs} locale/width keyboard journeys passed.\n`)
}
