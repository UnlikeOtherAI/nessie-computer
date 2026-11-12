// The AI tab: ChatGPT plans named and signed in one by one, background work
// consent kept, model servers saved, edited and removed, in every locale.
import assert from 'node:assert/strict'
import { LOCALES, assertFits, checkHelp, helpText, lastCall, openConsole, screenshot, selectTeam, showTab } from './renderer-page.mjs'

const RETIRED_WORDS = /\b(Executor|Strata|personal|Personal)\b/

export const verifyAiTab = async (browser, ui, output) => {
  for (const host of ['windows', 'macos']) {
    for (const locale of LOCALES) {
      for (const size of ['minimum', 'desktop']) {
        const { context, page, errors } = await openConsole(browser, ui, { host, locale, size, paired: 2 })
        const shot = (name) => screenshot(page, output, `${host}-ai-${name}-${locale}`)
        await showTab(page, 'ai')
        await page.waitForFunction(() => document.querySelector('#ai-chatgpt-list').textContent === window.nc.t('ai.emptyPlans'))
        const english = locale.startsWith('en')
        assert.equal(await page.locator('#tab-ai h2').count(), 0, 'the tab and the dropdown already name it: no heading')
        assert.equal(await page.locator('#team-row').isVisible(), true, 'the team row shows on AI')
        assert.doesNotMatch(await page.locator('#tab-ai').innerText(), RETIRED_WORDS)
        if (size === 'desktop') await shot('empty')
        // On Windows the first plan first connects the background service to the team: one more pairing code, claimed in Nessie.
        const windows = host === 'windows'
        // What a plan is — and on Windows how the first one connects — sits behind the "?" by the heading.
        const plansHelp = english && size === 'desktop' ? await checkHelp(page, 'ai-plans-hint') : await helpText(page, 'ai-plans-hint')
        if (english) assert.match(plansHelp, /A plan can be yours or your company’s/)
        assert.equal(/Adding the first plan connects it to Platform · UnlikeOtherAI/.test(plansHelp), english && windows)
        // Adding a plan prefills an editable name and needs the restriction understood before Sign in with ChatGPT.
        for (const n of [1, 2]) {
          await page.locator('#ai-add-chatgpt').click()
          if (windows && n === 1) {
            await page.waitForFunction(() => document.getElementById('ai-connection-code').textContent === '01234567')
            if (english) assert.equal(await page.locator('#ai-connection-title').textContent(), 'Connect ChatGPT plans for Platform · UnlikeOtherAI')
            assert.deepEqual((await lastCall(page, 'executor_chatgpt_connection_start')).args, { executorId: 'team-0' })
            await assertFits(page, `${host} ${locale} ${size} plan connection dialog`)
            if (size === 'desktop') await shot('connect-plans')
            await page.locator('#ai-connection-open-nessie').click()
            assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, {})
            await page.evaluate(() => window.claimPlanInNessie('team-0'))
            await page.waitForFunction(() => !document.getElementById('ai-connection-dialog').open)
            await page.waitForFunction(() => document.getElementById('chatgpt-dialog').open)
            if (english) assert.doesNotMatch(await helpText(page, 'ai-plans-hint'), /Adding the first plan/)
            assert.equal((await lastCall(page, 'executor_personal_chatgpt')).args.executorId, 'team-0-plans', 'plans live on the service connection')
            if (english) assert.equal(await page.locator('#chatgpt-team').textContent(), 'Platform · UnlikeOtherAI', 'the dialog names the team, not the connection')
          }
          await page.waitForFunction((value) => document.getElementById('chatgpt-name').value === value, await page.evaluate((i) => window.nc.t('ai.planName', { n: i }), n))
          if (english) {
            assert.equal(await page.locator('#chatgpt-title').textContent(), 'Add a ChatGPT plan')
            assert.equal(await page.locator('#chatgpt-start').textContent(), 'Sign in with ChatGPT')
          }
          assert.doesNotMatch(await page.locator('#chatgpt-dialog').innerText(), RETIRED_WORDS)
          // A plan keeps nothing else off the computer, so there is nothing to tick before signing in.
          assert.equal(await page.locator('#chatgpt-dialog input[type=checkbox]').count(), 0)
          if (n === 2) await page.locator('#chatgpt-name').fill('Company plan')
          await page.waitForFunction(() => !document.getElementById('chatgpt-start').disabled)
          if (n === 1 && size === 'desktop') await shot('add-plan')
          await page.locator('#chatgpt-start').click()
          await page.locator('#chatgpt-background').waitFor()
          const started = await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_personal_chatgpt'
            && call.args.operation.operation !== 'status').at(-1).args.operation)
          assert.equal(started.operation, 'start')
          assert.equal(started.acknowledgeHostRestriction, true)
          assert.equal(started.label, n === 1 ? await page.evaluate(() => window.nc.t('ai.planName', { n: 1 })) : 'Company plan')
          await assertFits(page, `${host} ${locale} ${size} signed-in plan dialog`)
          if (n === 1 && size === 'desktop') await shot('plan-signed-in')
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
        if (size === 'desktop') await shot('plan-failed')
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
        if (size === 'desktop') await shot('add-server')
        await page.locator('#endpoint-save').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        await page.locator('#ai-endpoint-list button').waitFor()
        assert.match(await page.locator('#ai-endpoint-list').textContent(), /Lab/)
        if (size === 'desktop') await shot('tab')
        await page.locator('#ai-endpoint-list button').click()
        assert.equal(await page.locator('#endpoint-key').inputValue(), '')
        assert.equal(await page.locator('#endpoint-clear-key-row').isVisible(), true)
        await page.evaluate(() => { window.endpointOffline = true })
        await page.locator('#endpoint-name').fill('Lab renamed')
        await page.locator('#endpoint-save').click()
        await page.locator('#endpoint-dialog [data-error-for=endpoint-save]').waitFor()
        assert.equal(await page.locator('#endpoint-name').inputValue(), 'Lab renamed')
        if (size === 'desktop') await shot('server-failed')
        await page.evaluate(() => { window.endpointOffline = false })
        await page.locator('#endpoint-save').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        await page.locator('#ai-endpoint-list button').click()
        await page.locator('#endpoint-remove').click()
        await page.locator('#endpoint-dialog').waitFor({ state: 'hidden' })
        await page.waitForFunction(() => window.endpoints.length === 0)
        if (locale === 'en-GB' && size === 'desktop') {
          // A server check that failed (Minis, 9 November) comes back by itself, without a click.
          await page.evaluate(() => { window.endpointOffline = true })
          await page.locator('#ai-refresh').click()
          await page.waitForFunction(() => document.getElementById('ai-endpoint-list').textContent === window.nc.t('ai.failed'))
          await page.evaluate(() => { window.endpointOffline = false })
          await page.waitForFunction(() => document.getElementById('ai-endpoint-list').textContent === window.nc.t('ai.emptyServers'),
            undefined, { timeout: 9000 })
        }
        await assertFits(page, `${host} ${locale} ${size} ai`)
        assert.deepEqual(errors, [])
        await context.close()
      }
    }
  }
  // The dropdown's team names the tab; dark follows the OS, in both window sizes.
  for (const size of ['desktop', 'minimum']) {
    const { context, page, errors } = await openConsole(browser, ui, { host: 'macos', locale: 'cs', dark: true, size, paired: 2 })
    await showTab(page, 'ai')
    await selectTeam(page, 'team-1')
    await page.waitForFunction(() => document.getElementById('team-select').value === 'team-1')
    await page.waitForFunction(() => document.querySelector('#ai-chatgpt-list').textContent === window.nc.t('ai.emptyPlans'))
    await assertFits(page, `cs dark ${size} ai`)
    await screenshot(page, output, `ai-cs-dark-${size}`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write('AI tab: plans, background work, servers and failures on both hosts in seven locales, both window sizes.\n')
}
