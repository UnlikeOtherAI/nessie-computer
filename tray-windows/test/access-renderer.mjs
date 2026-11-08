// The Access tab: folders, programs with Apply, websites, local apps and the
// developers' section, on both hosts, with failures beside their controls.
import assert from 'node:assert/strict'
import { LOCALES, assertFits, callCount, lastCall, openConsole, screenshot, selectTeam, showTab } from './renderer-page.mjs'

const current = (page) => page.locator('#access-programs-current').textContent()
const configured = (page) => page.evaluate(() => window.configured?.length ?? 0)
const waitConfigured = (page, count) => page.waitForFunction((n) => (window.configured?.length ?? 0) > n, count)
const openAccess = async (browser, ui, options) => {
  const opened = await openConsole(browser, ui, { paired: 2, ...options })
  await showTab(opened.page, 'access')
  await opened.page.locator('#access-body').waitFor()
  return opened
}

export const verifyAccessTab = async (browser, ui, output) => {
  for (const host of ['windows', 'macos']) {
    const { context, page, errors } = await openAccess(browser, ui, { host })
    const shot = (name) => screenshot(page, output, `${host}-access-${name}`)
    await page.getByRole('heading', { name: 'Access for Platform · UnlikeOtherAI' }).waitFor()
    assert.equal(await page.locator('#team-row').isVisible(), true, 'the team row shows on Access')

    // Folders: the name agents use beside the path; the last folder's Remove waits (the runtime keeps one).
    assert.match(await page.locator('#access-folder-list').textContent(), /Nessie.*Agents call it nessie/)
    assert.equal(await page.locator('#access-folder-list .list-row').count(), 2)
    await shot('folders')
    await page.getByRole('button', { name: 'Add folder…' }).click()
    await waitConfigured(page, 0)
    assert.deepEqual((await lastCall(page, 'executor_configure')).args.configurationInput.workspaceFolders.map((folder) => folder.name), ['nessie', 'shared', 'site'])
    await page.locator('#access-folder-list .list-row').nth(2).waitFor()
    await page.getByRole('button', { name: 'Stop sharing Nessie with Platform · UnlikeOtherAI' }).click()
    await page.getByRole('button', { name: 'Stop sharing Site with Platform · UnlikeOtherAI' }).click()
    await page.waitForFunction(() => window.teams['team-0'].folders.length === 1)
    assert.equal(await page.getByRole('button', { name: /Stop sharing/ }).isDisabled(), true)
    await page.getByText('Keep at least one folder.').waitFor()
    assert.equal(await page.evaluate(() => window.restarts), 0, 'a save never restarts the team')
    await shot('last-folder')

    // Programs: "Currently allowed" is the saved state; edits wait for Apply behind a before/after line.
    assert.equal(await current(page), 'Currently allowed: Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code.')
    assert.equal(await page.locator('#access-apply').isDisabled(), true)
    assert.equal(await page.locator('#access-after').textContent(), 'No changes to apply.')
    const before = await configured(page)
    await page.getByRole('switch', { name: 'Allow Claude Code' }).click()
    assert.equal(await current(page), 'Currently allowed: Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code.', 'an unsaved edit never looks effective')
    assert.equal(await page.locator('#access-after').textContent(), 'After Apply: Apps from UnlikeOtherAI, Codex, T3 Code')
    await page.getByRole('button', { name: 'Add program…' }).click()
    await page.locator('#access-program-name').fill('my tool')
    await page.locator('#access-program-confirm').click()
    await page.getByText('Use a program name without spaces, slashes or quotes.').waitFor()
    await shot('add-program-invalid')
    await page.locator('#access-program-name').fill('git')
    await page.locator('#access-program-confirm').click()
    await page.getByRole('button', { name: 'Remove git' }).waitFor()
    assert.equal(await configured(page), before, 'nothing saved before Apply')
    assert.equal(await page.locator('#access-after').textContent(), 'After Apply: Apps from UnlikeOtherAI, Codex, T3 Code, git')
    await page.locator('#access-programs').scrollIntoViewIfNeeded()
    await shot('programs-pending')
    await page.getByRole('button', { name: 'Apply' }).click()
    await waitConfigured(page, before)
    const policy = (await lastCall(page, 'executor_configure')).args.configurationInput.commandPolicy
    assert.deepEqual(policy, { mode: 'allowlist', allowlist: ['git *'], denylist: [], trusted: { unlikeotherai: true, claudeCode: false, codex: true, t3Code: true } })
    await page.waitForFunction(() => document.getElementById('access-programs-current').textContent === 'Currently allowed: Apps from UnlikeOtherAI, Codex, T3 Code, git.')
    assert.equal(await page.locator('#access-after').textContent(), 'No changes to apply.')
    // No programs is a real state: nothing on, nothing listed, and Apply still applies it.
    for (const name of ['Allow Apps from UnlikeOtherAI', 'Allow Codex', 'Allow T3 Code']) await page.getByRole('switch', { name }).click()
    await page.getByRole('button', { name: 'Remove git' }).click()
    assert.equal(await page.locator('#access-after').textContent(), 'After Apply: no programs')
    await page.getByText('No programs means agents in Platform · UnlikeOtherAI start nothing on this computer.').waitFor()
    await shot('programs-none-pending')
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.waitForFunction(() => document.getElementById('access-programs-current').textContent === 'Currently allowed: no programs.')
    assert.deepEqual((await lastCall(page, 'executor_configure')).args.configurationInput.commandPolicy,
      { mode: 'allowlist', allowlist: [], denylist: [], trusted: { unlikeotherai: false, claudeCode: false, codex: false, t3Code: false } })
    // Any program: the list greys out and says why; the consequence sentence sits beside the mode.
    await page.getByRole('radio', { name: 'Any program' }).check()
    await page.getByText('Not used while any program is allowed.').waitFor()
    assert.equal(await page.locator('#access-after').textContent(), 'After Apply: any program')
    assert.equal(await page.locator('.access-mode .hint').textContent(), 'Programs run as you and can open any file you can.')
    // An invalid pattern is said beside Advanced and blocks Apply; a valid one applies.
    await page.locator('#access-advanced summary').click()
    await page.locator('#access-denylist').fill('rm *\ngi*')
    await page.getByText('Use rules such as git * or npm run *, one per line.').waitFor()
    assert.equal(await page.locator('#access-apply').isDisabled(), true)
    await page.locator('#access-denylist').fill('rm *')
    await page.waitForFunction(() => !document.getElementById('access-apply').disabled)
    await shot('programs-advanced')
    // A save that fails says so beside Apply, names the rule still in force, and offers Try again.
    await page.evaluate(() => { window.failConfigure = 'Nessie Computer could not write this change.' })
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.getByRole('button', { name: 'Try again' }).waitFor()
    assert.equal(await page.locator('.save-problem > span').textContent(),
      'Programs weren’t saved: Nessie Computer could not write this change. Programs still allowed: no programs.')
    assert.equal(await current(page), 'Currently allowed: no programs.')
    await shot('programs-failed')
    await page.evaluate(() => { window.failConfigure = null })
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.waitForFunction(() => document.getElementById('access-programs-current').textContent === 'Currently allowed: any program except rm.')
    assert.equal(await page.locator('.save-problem').count(), 0)
    assert.equal(await page.evaluate(() => window.restarts), 0)
    assert.equal(await callCount(page, 'executor_apply_remedy'), 0, 'Try again resends the draft; it never applies a remedy')

    // Websites: a plain note while the agent browser is not set up; only https origins are accepted.
    await page.getByText('The agent browser isn’t set up on this computer yet.', { exact: false }).waitFor()
    await page.getByText('No websites yet.', { exact: false }).waitFor()
    await page.getByRole('button', { name: 'Add website…' }).click()
    await page.locator('#access-website-dialog-input').fill('http://docs.example.com/path')
    await page.locator('#access-website-dialog-confirm').click()
    await page.getByText('Use an https address such as https://example.com.').waitFor()
    await page.locator('#access-website-dialog-input').fill('docs.example.com')
    await page.locator('#access-website-dialog-confirm').click()
    await page.waitForFunction(() => window.teams['team-0'].allowedOrigins[0] === 'https://docs.example.com')
    await page.getByRole('button', { name: 'Remove https://docs.example.com' }).waitFor()
    await page.locator('#access-websites').scrollIntoViewIfNeeded()
    await shot('websites')

    // Local apps: every installed app on with a switch; one no longer installed says so.
    assert.equal(await page.locator('#access-local-app-list .list-row').count(), 3)
    await page.getByText('Not installed any more', { exact: false }).waitFor()
    await page.getByRole('switch', { name: 'Let Platform · UnlikeOtherAI use kelpie' }).click()
    await page.waitForFunction(() => window.teams['team-0'].mcpPolicy.disabled[0] === 'kelpie')
    assert.deepEqual((await lastCall(page, 'executor_configure')).args.configurationInput.mcpPolicy, { mode: 'installed', disabled: ['kelpie'] })

    // Coding assistants live under For developers; the switch saves when pressed; the Claude Code recipe is a dialog.
    assert.equal(await page.locator('#access-existing-sessions').isVisible(), false)
    await page.locator('#access-developers summary').click()
    assert.equal(await page.locator('#access-existing-sessions').isChecked(), true)
    await page.locator('#access-existing-sessions').click()
    await page.waitForFunction(() => window.teams['team-0'].existingSessions === false)
    await page.getByRole('button', { name: 'Set up Claude Code to receive messages…' }).click()
    assert.match(await page.locator('#access-claude-config').textContent(), /serve-existing-claude-channel/)
    await shot('claude-setup')
    await page.locator('#access-claude-close').click()
    await page.locator('#access-developers').scrollIntoViewIfNeeded()
    await shot('developers')

    // Another team shows its own rules at once; a team whose access cannot be read says so and offers Try again.
    await selectTeam(page, 'team-1')
    await page.getByRole('heading', { name: 'Access for Research · UnlikeOtherAI' }).waitFor()
    await page.waitForFunction(() => document.getElementById('access-programs-current').textContent === 'Currently allowed: any program except rm.')
    assert.equal(await page.locator('#access-browser-note').isHidden(), true, 'no note once the browser is set up')
    assert.equal(await page.locator('#access-existing-sessions').isChecked(), false)
    await page.evaluate(() => { window.failDescribe = 'The local request timed out.' })
    await selectTeam(page, 'team-0')
    await page.getByText('Couldn’t load access for Platform · UnlikeOtherAI. The local request timed out.').waitFor()
    await shot('load-failed')
    await page.evaluate(() => { window.failDescribe = null })
    await page.locator('#access-reload').click()
    await page.locator('#access-body').waitFor()
    // A program request answered on Overview is read back when the team is chosen again (once per selection).
    await page.evaluate(() => { window.teams['team-0'].policy = { mode: 'allowlist', allowlist: ['npm *'], denylist: [], trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true } } })
    await selectTeam(page, 'team-1')
    await selectTeam(page, 'team-0')
    await page.waitForFunction(() => document.getElementById('access-programs-current').textContent === 'Currently allowed: Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code, npm.')
    await assertFits(page, `${host} access`)
    assert.deepEqual(errors, [])
    await context.close()
  }

  // A runtime without local apps yet says so rather than showing an empty list.
  {
    const { context, page, errors } = await openAccess(browser, ui, { host: 'macos', legacy: true })
    await page.getByText('This version of Nessie Computer doesn’t list local apps yet.', { exact: false }).waitFor()
    assert.deepEqual(errors, [])
    await context.close()
  }

  // Every locale fits in the desktop and the smallest window, light and dark; Czech, dark and the smallest window are kept as pictures.
  let shots = 0
  for (const locale of LOCALES) {
    for (const size of ['minimum', 'desktop']) {
      for (const dark of [false, true]) {
        if (dark && locale !== 'en-GB' && locale !== 'cs') continue
        const { context, page, errors } = await openAccess(browser, ui, { host: 'macos', locale, size, dark })
        await page.locator('#access-developers summary').click()
        await page.getByRole('switch').first().click()
        await assertFits(page, `${locale} ${size} ${dark ? 'dark' : 'light'} access`)
        if (locale === 'cs' || dark || size === 'minimum') {
          await screenshot(page, output, `access-${locale}-${size}${dark ? '-dark' : ''}`)
          shots += 1
        }
        await page.getByRole('button', { name: /…$/ }).nth(1).click()
        await assertFits(page, `${locale} ${size} add program dialog`)
        assert.deepEqual(errors, [])
        await context.close()
      }
    }
  }
  process.stdout.write(`Access tab: both hosts, seven locales in both window sizes, ${shots} locale/dark pictures.\n`)
}
