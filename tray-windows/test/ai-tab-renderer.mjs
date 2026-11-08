// The AI tab: ChatGPT plans named and signed in one by one, background work
// consent kept, model servers saved, edited and removed, in every locale.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { assertFits, lastCall, openTeamTabs } from './team-tabs-host.mjs'

const LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']
const RETIRED_WORDS = /\b(Executor|Strata|personal|Personal)\b/

export const verifyAiTab = async (browser, ui, output) => {
  for (const host of ['windows', 'macos']) {
    for (const locale of LOCALES) {
      for (const width of [390, 1280]) {
        const { context, page, errors } = await openTeamTabs(browser, ui, { host, locale, width, height: 1200 })
        await page.getByRole('tab', { name: 'AI' }).click()
        await page.waitForFunction(() => document.querySelector('#ai-chatgpt-list').textContent === window.nc.t('ai.emptyPlans'))
        const english = locale.startsWith('en')
        if (english) assert.equal(await page.locator('#ai-heading').textContent(), 'AI for Platform · UnlikeOtherAI')
        assert.doesNotMatch(await page.locator('#tab-ai').innerText(), RETIRED_WORDS)
        // Adding a plan prefills an editable name and needs the restriction understood before Sign in with ChatGPT.
        for (const n of [1, 2]) {
          await page.locator('#ai-add-chatgpt').click()
          await page.waitForFunction((expected) => document.getElementById('chatgpt-name').value === expected, await page.evaluate((i) => window.nc.t('ai.planName', { n: i }), n))
          if (english) {
            assert.equal(await page.locator('#chatgpt-title').textContent(), 'Add a ChatGPT plan')
            assert.equal(await page.locator('#chatgpt-restriction-copy').textContent(),
              'While a ChatGPT plan is signed in, agents can’t open terminals or coding tools under your account. Sign out to get them back.')
            assert.equal(await page.locator('#chatgpt-start').textContent(), 'Sign in with ChatGPT')
          }
          assert.doesNotMatch(await page.locator('#chatgpt-dialog').innerText(), RETIRED_WORDS)
          assert.equal(await page.locator('#chatgpt-start').isDisabled(), true)
          if (n === 2) await page.locator('#chatgpt-name').fill('Company plan')
          await page.locator('#chatgpt-restriction').check()
          if (n === 1 && width === 1280) await page.screenshot({ path: join(output, `${host}-ai-add-plan-${locale}.png`), fullPage: true })
          await page.locator('#chatgpt-start').click()
          await page.locator('#chatgpt-background').waitFor()
          const started = await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_personal_chatgpt'
            && call.args.operation.operation !== 'status').at(-1).args.operation)
          assert.equal(started.operation, 'start')
          assert.equal(started.acknowledgeHostRestriction, true)
          assert.equal(started.label, n === 1 ? await page.evaluate(() => window.nc.t('ai.planName', { n: 1 })) : 'Company plan')
          assert.ok((await page.locator('#chatgpt-background').boundingBox()).height >= 44)
          await page.locator('#chatgpt-close').click()
        }
        await page.locator('#ai-chatgpt-list button').nth(1).waitFor()
        assert.match(await page.locator('#ai-chatgpt-list').textContent(), /Company plan/)
        if (english) assert.match(await page.locator('#ai-chatgpt-list').textContent(), /ChatGPT plan 1.*Signed in\. Funds your own agents\./)
        // Background work: on, then off, each fenced by the revision it saw; a failed read keeps the last button.
        await page.locator('#ai-chatgpt-list button').first().click()
        await page.locator('#chatgpt-background').waitFor()
        await page.locator('#chatgpt-background').click()
        await page.waitForFunction(() => window.chatgptProfiles[0].backgroundConsentRevision === 1)
        await page.evaluate(() => { window.chatgptOffline = true })
        await page.locator('#chatgpt-refresh').click()
        await page.waitForFunction(() => document.getElementById('chatgpt-status').textContent === window.nc.t('chatgpt.failed'))
        if (width === 1280) await page.screenshot({ path: join(output, `${host}-ai-plan-failed-${locale}.png`), fullPage: true })
        await page.evaluate(() => { window.chatgptOffline = false })
        await page.locator('#chatgpt-background').click()
        await page.waitForFunction(() => window.chatgptProfiles[0].backgroundConsentRevision === null)
        assert.equal(await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_personal_chatgpt'
          && call.args.operation.operation === 'background-consent').at(-1).args.operation.expectedRevision), 1)
        const closes = await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_personal_chatgpt'
          && ['cancel', 'disconnect'].includes(call.args.operation.operation)).length)
        await page.locator('#chatgpt-close').click()
        assert.equal(closes, 0, 'closing never cancels a sign-in or clears custody')
        // Model servers: save, edit, a failed save that keeps the form, remove.
        await page.locator('#ai-add-endpoint').click()
        await page.locator('#endpoint-name').fill('Lab')
        await page.locator('#endpoint-address').fill('http://192.168.1.90:8080/v1')
        await page.locator('#endpoint-scope').selectOption('network')
        await page.locator('#endpoint-key').fill('test-only-key')
        await page.locator('#endpoint-save').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        await page.locator('#ai-endpoint-list button').waitFor()
        assert.match(await page.locator('#ai-endpoint-list').textContent(), /Lab/)
        if (width === 1280) await page.screenshot({ path: join(output, `${host}-ai-${locale}.png`), fullPage: true })
        await page.locator('#ai-endpoint-list button').click()
        assert.equal(await page.locator('#endpoint-key').inputValue(), '')
        assert.equal(await page.locator('#endpoint-clear-key-row').isVisible(), true)
        await page.evaluate(() => { window.endpointOffline = true })
        await page.locator('#endpoint-name').fill('Lab renamed')
        await page.locator('#endpoint-save').click()
        await page.locator('#endpoint-dialog .attempt-error').waitFor()
        assert.equal(await page.locator('#endpoint-name').inputValue(), 'Lab renamed')
        if (width === 1280) await page.screenshot({ path: join(output, `${host}-ai-server-failed-${locale}.png`), fullPage: true })
        await page.evaluate(() => { window.endpointOffline = false })
        await page.locator('#endpoint-save').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        await page.locator('#ai-endpoint-list button').click()
        await page.locator('#endpoint-remove').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        await page.waitForFunction(() => window.endpoints.length === 0)
        await assertFits(page, `${host} ${locale} ${width} ai`)
        assert.deepEqual(errors, [])
        await context.close()
      }
    }
  }
  // The dropdown's team names the tab; dark follows the OS.
  {
    const { context, page, errors } = await openTeamTabs(browser, ui, { host: 'macos', locale: 'cs', dark: true, height: 1000 })
    await page.getByRole('tab', { name: 'AI' }).click()
    await page.locator('#connection').selectOption('team-1')
    await page.waitForFunction(() => document.getElementById('ai-heading').textContent === window.nc.t('ai.heading', { team: 'Research · UnlikeOtherAI' }))
    await page.screenshot({ path: join(output, 'ai-cs-dark.png'), fullPage: true })
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write('AI tab: plans, background work, servers and failures on both hosts in seven locales at 390 and 1280 px.\n')
}
