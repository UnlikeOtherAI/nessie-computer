// The AI tab's "On this computer": Claude Code and Codex rows above ChatGPT
// plans, Make available per team, a program not installed greyed out, a
// signed-out hint, another account added, signed in and removed, a Windows
// service team, and a failed check — on both hosts, in seven locales, light
// and dark. Assertions only: this journey takes no pictures.
import assert from 'node:assert/strict'
import { LOCALES, assertFits, callArgs, lastCall, openConsole, selectTeam, showTab } from './renderer-page.mjs'

const rowText = (page, index) => page.locator('#ai-local-list .list-row').nth(index).innerText()
const word = (page, key, vars) => page.evaluate(([name, values]) => window.nc.t(`aiLocal.${name}`, values), [key, vars])

export const verifyAiLocal = async (browser, ui) => {
  for (const host of ['windows', 'macos']) {
    for (const locale of LOCALES) {
      for (const size of ['desktop', 'minimum']) {
        const { context, page, errors } = await openConsole(browser, ui, { host, locale, size, paired: 2 })
        await showTab(page, 'ai')
        await page.locator('#ai-local-list .list-row').nth(1).waitFor()
        const team = 'Platform · UnlikeOtherAI'
        // On this computer comes first, above ChatGPT plans.
        assert.equal(await page.evaluate(() => Boolean(document.getElementById('ai-local')
          .compareDocumentPosition(document.getElementById('ai-plans-title')) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
        if (locale.startsWith('en')) {
          assert.equal(await page.locator('#ai-local-title').textContent(), 'On this computer')
          assert.match(await rowText(page, 0), /Claude Code\s+person@example\.com/)
          assert.match(await rowText(page, 1), /Codex\s+Not installed on this computer/)
        }
        // Not installed: the row is greyed out and its switch cannot be pressed.
        assert.equal(await page.locator('#ai-local-list .list-row').nth(1).getAttribute('aria-disabled'), 'true')
        assert.equal(await page.locator('#ai-local-list .list-row').nth(1).getByRole('switch').isDisabled(), true)
        await assertFits(page, `${host} ${locale} ${size} on this computer`)
        // On by default: installed and signed in is already available to the team's agents.
        const claudeSwitch = page.locator('#ai-local-list .list-row').nth(0).getByRole('switch')
        assert.equal(await claudeSwitch.isChecked(), true)
        assert.match(await rowText(page, 0), new RegExp(await word(page, 'offered', { team })))
        // Switching off saves when pressed, for the team in the dropdown only.
        await claudeSwitch.uncheck()
        assert.deepEqual((await lastCall(page, 'executor_set_local_ai')).args,
          { executorId: 'team-0', engine: 'claude-code', profileId: null, available: false })
        await page.waitForFunction((text) => !document.querySelector('#ai-local-list .list-row').innerText.includes(text),
          await word(page, 'offered', { team }))
        await selectTeam(page, 'team-1')
        await page.waitForFunction(() => window.calls.filter((call) => call.command === 'executor_local_ai'
          && call.args.executorId === 'team-1').length > 0)
        await page.locator('#ai-local-list .list-row').nth(1).waitFor()
        assert.equal(await page.locator('#ai-local-list .list-row').nth(0).getByRole('switch').isChecked(), true)
        await selectTeam(page, 'team-0')
        await page.locator('#ai-local-list .list-row').nth(1).waitFor()
        await page.locator('#ai-local-list .list-row').nth(0).getByRole('switch').check()
        assert.equal((await lastCall(page, 'executor_set_local_ai')).args.available, true)
        // Nessie not offering it yet, and a signed-out program, say so in plain words.
        await page.evaluate(() => {
          window.localAiOffered = 'not_yet'
          window.localAiPrograms.codex = { installed: true, signedIn: false }
        })
        await page.locator('#ai-refresh').click()
        await page.waitForFunction((text) => document.querySelector('#ai-local-list').innerText.includes(text),
          await word(page, 'signedOut', { program: 'codex' }))
        assert.match(await rowText(page, 0), new RegExp(await word(page, 'notYet')))
        assert.equal(await page.locator('#ai-local-list .list-row').nth(1).getAttribute('aria-disabled'), null)
        // Another Claude account: a prefilled name, the program's own sign-in, then it shows up signed in.
        await page.locator('#ai-local-add button').first().click()
        await page.locator('#ai-local-dialog').waitFor()
        assert.equal(await page.locator('#ai-local-name').inputValue(), await word(page, 'accountName.claude-code', { n: 2 }))
        if (locale.startsWith('en')) {
          assert.equal(await page.locator('#ai-local-dialog-title').textContent(), 'Add another Claude account')
          assert.equal(await page.locator('#ai-local-confirm').textContent(), 'Sign in with Claude Code')
        }
        await assertFits(page, `${host} ${locale} ${size} add account`)
        await page.locator('#ai-local-name').fill('Work')
        await page.locator('#ai-local-confirm').click()
        await page.locator('#ai-local-dialog').waitFor({ state: 'hidden' })
        assert.deepEqual((await lastCall(page, 'executor_local_ai_add_account')).args,
          { executorId: 'team-0', engine: 'claude-code', name: 'Work' })
        await page.locator('#ai-local-list .list-row').nth(2).waitFor()
        assert.match(await rowText(page, 2), new RegExp(await word(page, 'signedOutAccount')))
        assert.equal(await page.locator('#ai-local-list .list-row').nth(2).getByRole('switch').isChecked(), true,
          'a new account is on by default and offered once it signs in')
        await page.evaluate(() => { window.localAiAccounts[0].signedIn = true })
        await page.waitForFunction(() => document.querySelectorAll('#ai-local-list .list-row')[2].innerText.includes('work@example.com'),
          undefined, { timeout: 8000 })
        // Removing it asks first, then signs it out.
        await page.locator('#ai-local-list .list-row').nth(2).getByRole('button').last().click()
        await page.locator('#ai-local-dialog').waitFor()
        assert.equal(await page.locator('#ai-local-name').isHidden(), true)
        await page.locator('#ai-local-confirm').click()
        await page.locator('#ai-local-dialog').waitFor({ state: 'hidden' })
        assert.deepEqual((await callArgs(page, 'executor_local_ai_remove_account')).map((args) => args.profileId),
          ['00000000-0000-4000-8000-000000000001'])
        await page.waitForFunction(() => document.querySelectorAll('#ai-local-list .list-row').length === 2)
        // A failed check keeps the rest of the tab working.
        await page.evaluate(() => { window.localAiOffline = true })
        await page.locator('#ai-refresh').click()
        await page.waitForFunction((text) => document.getElementById('ai-local-list').textContent === text, await word(page, 'failed'))
        assert.equal(await page.locator('#ai-add-chatgpt').isEnabled(), true)
        await page.evaluate(() => { window.localAiOffline = false })
        if (locale === 'en-GB' && size === 'desktop') {
          // It checks again by itself (Minis, 9 November): the rows come back without a click.
          await page.waitForFunction(() => document.querySelectorAll('#ai-local-list .list-row').length === 2, undefined, { timeout: 9000 })
        }
        if (host === 'windows') {
          // A team the background service runs cannot use the owner's sign-in.
          await page.evaluate(() => { window.localAiService = ['team-0'] })
          await page.locator('#ai-refresh').click()
          await page.locator('#ai-local-service').waitFor()
          assert.equal(await page.locator('#ai-local-list .list-row').count(), 0)
          await assertFits(page, `${host} ${locale} ${size} service team`)
        }
        assert.deepEqual(errors, [])
        await context.close()
      }
    }
  }
  for (const locale of ['en-GB', 'cs']) {
    const { context, page, errors } = await openConsole(browser, ui, { host: 'macos', locale, dark: true, paired: 2 })
    await showTab(page, 'ai')
    await page.locator('#ai-local-list .list-row').nth(1).waitFor()
    await page.waitForFunction(() => document.querySelector('#ai-local-list .list-row').innerText.includes('·'))
    await assertFits(page, `dark ${locale} on this computer`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write('AI tab, On this computer: rows, switches per team, accounts, service teams and failures on both hosts in seven locales.\n')
}
