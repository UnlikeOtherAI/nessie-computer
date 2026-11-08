// The AI tab's "On this computer": Claude Code and Codex rows above ChatGPT
// plans, Make available per team, a program not installed greyed out, a
// signed-out hint, another account added, signed in and removed, a Windows
// service team, and a failed check — on both hosts, in seven locales.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'
import { LOCALES, assertFits, callArgs, lastCall, openConsole, screenshot, selectTeam, showTab } from './renderer-page.mjs'

const rowText = (page, index) => page.locator('#ai-local-list .list-row').nth(index).innerText()
const word = (page, key, vars) => page.evaluate(([name, values]) => window.nc.t(`aiLocal.${name}`, values), [key, vars])

export const verifyAiLocal = async (browser, ui, output) => {
  for (const host of ['windows', 'macos']) {
    for (const locale of LOCALES) {
      for (const size of ['desktop', 'minimum']) {
        const pictures = size === 'desktop' && ['en-GB', 'cs'].includes(locale)
        const { context, page, errors } = await openConsole(browser, ui, { host, locale, size, paired: 2 })
        const shot = (name) => (pictures ? screenshot(page, output, `${host}-ai-local-${name}-${locale}`) : undefined)
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
        await shot('rows')
        // Make available saves when pressed, for the team in the dropdown only.
        await page.locator('#ai-local-list .list-row').nth(0).getByRole('switch').check()
        assert.deepEqual((await lastCall(page, 'executor_set_local_ai')).args,
          { executorId: 'team-0', engine: 'claude-code', profileId: null, available: true })
        await page.waitForFunction((text) => document.querySelector('#ai-local-list .list-row').innerText.includes(text),
          await word(page, 'offered', { team }))
        await shot('available')
        await selectTeam(page, 'team-1')
        await page.waitForFunction(() => window.calls.filter((call) => call.command === 'executor_local_ai'
          && call.args.executorId === 'team-1').length > 0)
        await page.locator('#ai-local-list .list-row').nth(1).waitFor()
        assert.equal(await page.locator('#ai-local-list .list-row').nth(0).getByRole('switch').isChecked(), false)
        await selectTeam(page, 'team-0')
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
        await shot('signed-out')
        // Another Claude account: a prefilled name, the program's own sign-in, then it shows up signed in.
        await page.locator('#ai-local-add button').first().click()
        await page.locator('#ai-local-dialog').waitFor()
        assert.equal(await page.locator('#ai-local-name').inputValue(), await word(page, 'accountName.claude-code', { n: 2 }))
        if (locale.startsWith('en')) {
          assert.equal(await page.locator('#ai-local-dialog-title').textContent(), 'Add another Claude account')
          assert.equal(await page.locator('#ai-local-confirm').textContent(), 'Sign in with Claude Code')
        }
        await assertFits(page, `${host} ${locale} ${size} add account`)
        await shot('add-account')
        await page.locator('#ai-local-name').fill('Work')
        await page.locator('#ai-local-confirm').click()
        await page.locator('#ai-local-dialog').waitFor({ state: 'hidden' })
        assert.deepEqual((await lastCall(page, 'executor_local_ai_add_account')).args,
          { executorId: 'team-0', engine: 'claude-code', name: 'Work' })
        await page.locator('#ai-local-list .list-row').nth(2).waitFor()
        assert.match(await rowText(page, 2), new RegExp(await word(page, 'signedOutAccount')))
        await shot('account-signed-out')
        await page.evaluate(() => { window.localAiAccounts[0].signedIn = true })
        await page.waitForFunction(() => document.querySelectorAll('#ai-local-list .list-row')[2].innerText.includes('work@example.com'),
          undefined, { timeout: 8000 })
        // Removing it asks first, then signs it out.
        await page.locator('#ai-local-list .list-row').nth(2).getByRole('button').last().click()
        await page.locator('#ai-local-dialog').waitFor()
        assert.equal(await page.locator('#ai-local-name').isHidden(), true)
        await shot('remove-account')
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
        if (host === 'windows') {
          // A team the background service runs cannot use the owner's sign-in.
          await page.evaluate(() => { window.localAiService = ['team-0'] })
          await page.locator('#ai-refresh').click()
          await page.locator('#ai-local-service').waitFor()
          assert.equal(await page.locator('#ai-local-list .list-row').count(), 0)
          await assertFits(page, `${host} ${locale} ${size} service team`)
          await shot('service-team')
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
    await page.locator('#ai-local-list .list-row').nth(0).getByRole('switch').check()
    await page.waitForFunction(() => document.querySelector('#ai-local-list .list-row').innerText.includes('·'))
    await assertFits(page, `dark ${locale} on this computer`)
    await screenshot(page, output, `macos-ai-local-dark-${locale}`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write('AI tab, On this computer: rows, switches per team, accounts, service teams and failures on both hosts in seven locales.\n')
}

/** The AI tab as `revision` rendered it, for side-by-side comparison. */
export const captureAiBefore = async (browser, root, revision, output) => {
  await mkdir(output, { recursive: true })
  const listed = execFileSync('git', ['ls-tree', '--name-only', revision, 'packages/executor-console/'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((path) => path.split('/').pop())
  for (const [locale, colorScheme] of [['en-GB', 'light'], ['cs', 'light'], ['en-GB', 'dark'], ['cs', 'dark']]) {
    const context = await browser.newContext({ viewport: { width: 640, height: 680 }, locale, colorScheme })
    await installRendererHost(context, 'macos', { paired: 2 })
    const page = await context.newPage()
    await page.route('http://localhost:5875/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
      await route.fulfill({ contentType, body: listed.includes(file)
        ? execFileSync('git', ['show', `${revision}:packages/executor-console/${file}`], { cwd: root, maxBuffer: 4_000_000 }) : '' })
    })
    await page.goto('http://localhost:5875/')
    await showTab(page, 'ai')
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(output, `macos-ai-${locale}-${colorScheme}.png`) })
    await context.close()
  }
}
