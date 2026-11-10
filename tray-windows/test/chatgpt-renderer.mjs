// Local-only journey through the real AI tab and named ChatGPT dialog.
import assert from 'node:assert/strict'
import { LOCALES, assertFits, openConsole, screenshot, showTab } from './renderer-page.mjs'

export const verifyChatgptDialog = async (browser, ui, output) => {
  for (const locale of LOCALES) {
    for (const size of ['desktop', 'minimum']) {
      const { context, page, errors } = await openConsole(browser, ui, { host: 'macos', locale, size, paired: 1 })
      await showTab(page, 'ai')
      await page.locator('#ai-add-chatgpt').click()
      await page.locator('#chatgpt-name').fill('ChatGPT OR Main')
      await page.locator('#chatgpt-restriction').check()
      // Every closed protocol reason is translated and announced as an error.
      // Checking again never loses the name or the person's acknowledgement.
      const reasons = await page.evaluate(() => Object.keys(window.chatgptDialog.reasons).filter((reason) => reason !== 'other'))
      for (const reason of [...reasons, 'future_reason']) {
        await page.evaluate((value) => { window.chatgptReason = value }, reason)
        await page.locator('#chatgpt-refresh').click()
        const expected = await page.evaluate((value) => window.nc.t(`chatgpt.unavailable.${value}`),
          reason === 'future_reason' ? 'other' : reason)
        await page.waitForFunction((value) => document.getElementById('chatgpt-status').textContent === value, expected)
        assert.equal(await page.locator('#chatgpt-status').getAttribute('role'), 'alert')
        assert.equal(await page.locator('#chatgpt-status').evaluate((node) => node.classList.contains('dialog-error')), true)
        assert.equal(await page.locator('#chatgpt-status').isVisible(), true)
        assert.equal(await page.locator('#chatgpt-name').inputValue(), 'ChatGPT OR Main')
        assert.equal(await page.locator('#chatgpt-restriction').isChecked(), true)
        await assertFits(page, `${locale} ${size} ${reason}`)
        if (locale === 'en-GB' && ['runtime_inventory_unknown', 'deployment_ineligible'].includes(reason)) {
          await screenshot(page, output, `chatgpt-${reason}-${size}`)
        }
      }
      // A transport failure blocks sign-in until a successful check, with
      // the same error styling on manual retries and automatic polls.
      await page.evaluate(() => { window.chatgptReason = null; window.chatgptOffline = true })
      await page.locator('#chatgpt-refresh').click()
      await page.waitForFunction(() => document.getElementById('chatgpt-status').textContent === window.nc.t('chatgpt.failed'))
      assert.equal(await page.locator('#chatgpt-start').isDisabled(), true)
      await page.locator('#chatgpt-refresh').click()
      assert.equal(await page.locator('#chatgpt-status').isVisible(), true)
      await page.evaluate(() => { window.chatgptOffline = false })
      await page.locator('#chatgpt-refresh').click()
      await page.waitForFunction(() => document.getElementById('chatgpt-status').getAttribute('role') === 'status')
      assert.equal(await page.locator('#chatgpt-start').isEnabled(), true)
      assert.equal(await page.locator('#chatgpt-status').evaluate((node) => node.classList.contains('dialog-error')), false)
      await page.locator('#chatgpt-start').click()
      await page.locator('#chatgpt-background').waitFor()
      const start = await page.evaluate(() => window.calls.find((call) => call.command === 'executor_personal_chatgpt'
        && call.args.operation.operation === 'start').args.operation)
      assert.equal(start.label, 'ChatGPT OR Main')
      assert.equal(start.acknowledgeHostRestriction, true)
      assert.match(start.newProfileId, /^[a-f0-9-]{36}$/)
      assert.equal(await page.locator('#chatgpt-name').inputValue(), 'ChatGPT OR Main')
      assert.deepEqual(errors, [])
      await context.close()
    }
  }
  process.stdout.write('ChatGPT dialog: named start, every refusal, failed checks and recovery; seven locales, two window sizes.\n')
}
