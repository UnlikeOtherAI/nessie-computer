// Shell journeys for the shared Nessie Computer console: welcome, Add this
// computer, the connected card, Overview with two teams, Needs you, a failure
// with its remedy, Settings, Czech, dark and the smallest window. Both hosts
// render the same document.
import assert from 'node:assert/strict'
import { syncCases } from './sync-fixtures.mjs'
import { callCount, lastCall, openConsole, screenshot, showTab } from './renderer-page.mjs'

export const verifyConsoleShell = async (browser, ui, output) => {
  let journeys = 0
  const open = async (options) => {
    const opened = await openConsole(browser, ui, { sync: null, ...options })
    return { ...opened, shot: (name) => screenshot(opened.page, output, `${options.host}-${name}`) }
  }

  for (const host of ['windows', 'macos']) {
    const { context, page, errors, shot } = await open({ host })
    const status = () => page.locator('#status-sentence').textContent()
    const footer = () => page.locator('#save-status').textContent()

    // Welcome: nothing connected, one button, no team row, no Pause all, no in-page Close.
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-GB')
    assert.equal(await page.title(), 'Nessie Computer')
    assert.equal(await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true')
    assert.ok((await page.locator('.tabs').boundingBox()).height <= 32)
    await page.getByText('Nothing is shared until you add this computer to a team.').waitFor()
    assert.equal(await status(), 'No team connected yet')
    assert.equal(await page.locator('#team-row').isHidden(), true)
    assert.equal(await page.locator('#pause-all').isHidden(), true)
    assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).count(), 0)
    // Content text is selectable; controls are not.
    assert.equal(await page.locator('#overview-welcome-text').evaluate((node) => getComputedStyle(node).userSelect), 'text')
    assert.equal(await page.locator('#overview-welcome-connect').evaluate((node) => getComputedStyle(node).userSelect), 'none')
    await shot('welcome')
    // A team tab with nothing connected offers Add this computer instead of an empty page.
    await page.getByRole('tab', { name: 'Access' }).click()
    await page.locator('#no-team').waitFor()
    await page.locator('#no-team').getByText('Add this computer to a team to choose what that team may use.').waitFor()
    assert.equal(await page.locator('#no-team-connect').textContent(), 'Add this computer')
    assert.equal(await page.locator('#team-row').isHidden(), true)
    await shot('no-team')
    // Arrow keys move between tabs.
    await page.getByRole('tab', { name: 'Access' }).focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true')

    // Add this computer asks the hosted Nessie for a code at once: no address field shown, filled or focused.
    await page.getByRole('button', { name: 'Add this computer', exact: true }).first().click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.equal(await page.locator('#connect-title').textContent(), 'Add this computer')
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { apiBaseUrl: 'https://api.nessie.works' })
    assert.equal(await page.locator('#pairing-server').isVisible(), false)
    assert.equal(await page.locator('#connect-advanced').evaluate((details) => details.open), false)
    assert.equal(await page.locator('#pairing-server').inputValue(), '')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'connect-title')
    // The countdown runs to the server's expiresAt (five minutes from the hosted Nessie).
    assert.match(await page.locator('#pairing-time').textContent(), /^Expires in 4:[45]\d$/)
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'In Nessie, open Computers and choose Add a computer.')
    assert.equal(await page.getByRole('dialog').getByText(/fingerprint/i).count(), 0)
    assert.equal(await page.getByRole('dialog').locator('input[type=checkbox]').count(), 0)
    await page.getByRole('button', { name: 'Copy pairing code' }).click()
    assert.deepEqual((await lastCall(page, 'executor_copy_code')).args, { code: '01234567' })
    // The host builds the URL and adds the code itself (§5.1): the page passes no path.
    await page.getByRole('button', { name: 'Open Nessie to finish' }).click()
    assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, {})
    await shot('connect')
    // An expired code stays visible, greyed, with Get a new code; checks continue meanwhile.
    await page.evaluate(() => { window.expiresAt = new Date(Date.now() - 1000).toISOString() })
    await page.getByRole('button', { name: 'Get a new code' }).waitFor()
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'This code has expired.')
    assert.equal(await page.locator('#pairing-code').textContent(), '01234567')
    assert.equal(await page.locator('#pairing-code').evaluate((node) => node.classList.contains('expired')), true)
    const checks = await callCount(page, 'executor_pairing_status')
    await page.waitForFunction((before) => window.calls.filter((call) => call.command === 'executor_pairing_status').length > before, checks)
    await shot('connect-expired')
    await page.evaluate(() => { window.expiresAt = undefined; window.pairStatus = 'waiting' })
    await page.getByRole('button', { name: 'Get a new code' }).click()
    await page.waitForFunction(() => !document.getElementById('pairing-code').classList.contains('expired'))
    // Escape cancels the attempt rather than hiding a live code.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_pairing_cancel'))
    await page.waitForFunction(() => !document.getElementById('connect-dialog').open)
    // A request Nessie refuses says why, with Try again; it never opens the server address.
    await page.evaluate(() => { window.pairingFailure = 'Nessie couldn’t finish this step. Check your connection and try again.' })
    await page.getByRole('button', { name: 'Add this computer', exact: true }).first().click()
    await page.locator('#pairing-error').getByText('Nessie couldn’t finish this step. Check your connection and try again.').waitFor()
    assert.equal(await page.locator('#connect-advanced').evaluate((details) => details.open), false)
    assert.equal(await page.locator('#connect-progress').isHidden(), true)
    assert.equal(await page.locator('#pairing-open-nessie').isHidden(), true)
    await shot('connect-failed')
    await page.evaluate(() => { window.pairingFailure = null })
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.equal(await page.locator('#pairing-error').isHidden(), true)
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { apiBaseUrl: 'https://api.nessie.works' })
    // The organisation's own server sits behind one link, empty until typed; a refused address is reported beside it.
    await page.locator('#connect-advanced summary').click()
    assert.equal(await page.locator('#pairing-server').inputValue(), '')
    assert.equal(await page.locator('#pairing-server').getAttribute('placeholder'), 'https://nessie.example.com')
    await page.locator('#pairing-server').fill('http://nessie.example.com')
    await page.getByRole('button', { name: 'Get code', exact: true }).click()
    await page.locator('#pairing-server-error').getByText('The server address must start with https://.').waitFor()
    assert.equal(await page.locator('#pairing-server').getAttribute('aria-invalid'), 'true')
    await shot('connect-own-server')
    await page.locator('#pairing-server').fill('https://nessie.example.com')
    await page.getByRole('button', { name: 'Get code', exact: true }).click()
    await page.waitForFunction(() => window.pairServer === 'https://nessie.example.com')
    assert.equal(await page.locator('#pairing-server-error').isHidden(), true)
    // Asked again while that code waits, the dialog keeps its code and names the server it belongs to.
    await page.locator('#pairing-server').fill('')
    const startsBefore = await callCount(page, 'executor_pairing_start')
    await page.evaluate(() => window.emitTray('tray://connect'))
    await page.waitForFunction(() => document.getElementById('pairing-server').value === 'https://nessie.example.com')
    assert.equal(await page.locator('#connect-advanced').evaluate((details) => details.open), true)
    assert.equal(await callCount(page, 'executor_pairing_start'), startsBefore)
    // The claim in Nessie finishes it: the dialog closes and Overview shows what the team may use.
    await page.evaluate(() => window.claimInNessie())
    await page.locator('#overview-connected:not([hidden])').waitFor()
    assert.equal(await page.locator('#connect-dialog').evaluate((dialog) => dialog.open), false)
    assert.equal(await page.locator('#connected-title').textContent(), 'Connected to Platform · UnlikeOtherAI')
    await page.locator('#connected-body').getByText('Agents in this team can now use: 1 folder · UnlikeOtherAI apps, Claude Code, Codex, T3 Code · all local apps · no websites.').waitFor()
    assert.equal(await status(), 'Working for 1 team')
    await shot('connected')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    assert.equal(await page.locator('#overview-connected').isHidden(), true)

    // Two teams, one paused: cards name the team, its status, its access and who may send work.
    await page.getByRole('button', { name: 'Add this computer', exact: true }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.evaluate(() => window.claimInNessie())
    await page.waitForFunction(() => document.querySelectorAll('#team-cards .team-card').length === 2)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    const card = (team) => page.locator('.team-card', { hasText: team })
    await card('Research · UnlikeOtherAI').locator('.team-audience-text').getByText('Agents: Jev · People: Ondrej').waitFor()
    await card('Research · UnlikeOtherAI').locator('.team-summary').getByText('1 folder · any program · no local apps · 1 website').waitFor()
    await card('Research · UnlikeOtherAI').getByRole('button', { name: 'Pause', exact: true }).click()
    await card('Research · UnlikeOtherAI').locator('.status-word').getByText('Paused').waitFor()
    assert.deepEqual((await lastCall(page, 'executor_set_paused')).args, { executorId: 'team-1', paused: true })
    assert.equal(await status(), 'Working for 1 team · 1 paused')
    assert.equal(await footer(), 'Paused. Agents wait until you resume.')
    assert.equal(await card('Platform · UnlikeOtherAI').locator('.status-word').textContent(), 'Working')
    await shot('overview-two-teams')
    await page.getByRole('button', { name: 'Pause all', exact: true }).click()
    await page.getByRole('button', { name: 'Resume all', exact: true }).waitFor()
    assert.deepEqual((await lastCall(page, 'executor_set_paused')).args, { executorId: null, paused: true })
    assert.equal(await status(), 'Paused')
    await shot('overview-paused')
    await page.getByRole('button', { name: 'Resume all', exact: true }).click()
    await page.getByRole('button', { name: 'Pause all', exact: true }).waitFor()
    assert.equal(await status(), 'Working for 2 teams')
    // Change access lands on Access with that team selected, and the tab names it.
    await card('Research · UnlikeOtherAI').getByRole('button', { name: 'Change access' }).click()
    assert.equal(await page.getByRole('tab', { name: 'Access' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-row').isVisible(), true)
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
    assert.equal(await page.locator('#team-select option', { hasText: 'Research · UnlikeOtherAI' }).count(), 1)
    await page.getByRole('heading', { name: 'Access for Research · UnlikeOtherAI' }).waitFor()
    await page.getByRole('tab', { name: 'Settings' }).click()
    assert.equal(await page.locator('#team-row').isHidden(), true)
    await page.getByRole('tab', { name: 'Overview' }).click()

    // Needs you: a program request, and Documents waiting for a decision.
    const attention = { ...syncCases(host).find((entry) => entry.name === 'claims-up-to-date-with-conflict').state, executorId: 'team-1' }
    await page.evaluate((state) => {
      window.requests = [{ executorId: 'team-0', id: 'req-1', program: 'git', args: ['push', 'origin', 'main'], agentName: 'Jev',
        requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90000).toISOString() }]
      window.paired[0].pendingProgramRequests = 1
      window.syncStates['team-1'] = state
    }, attention)
    const needs = page.locator('#needs-you-list')
    await needs.getByText('Jev wants to run git').waitFor()
    await needs.getByText('Documents for Research · UnlikeOtherAI need you: files to check').waitFor()
    assert.equal(await status(), 'Needs you: Jev wants to run git')
    assert.equal(await card('Platform · UnlikeOtherAI').locator('.status-word').textContent(), 'Needs you')
    assert.equal(await page.getByRole('button', { name: 'Allow once' }).count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Don’t allow' }).count(), 1)
    await shot('needs-you')
    await page.getByRole('button', { name: 'Always allow git' }).click()
    await page.waitForFunction(() => window.teams['team-0'].policy.allowlist.includes('git *'))
    assert.deepEqual(await page.evaluate(() => window.answers), [{ id: 'req-1', answer: 'always' }])
    await page.waitForFunction(() => !document.body.textContent.includes('Jev wants to run git'))
    await page.getByRole('button', { name: 'Open Documents' }).click()
    assert.equal(await page.getByRole('tab', { name: 'Documents' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
    await page.getByRole('heading', { name: 'Documents for Research · UnlikeOtherAI' }).waitFor()
    await page.waitForFunction(() => document.getElementById('documents-state-text').textContent === 'Needs your attention')
    await page.evaluate(() => { delete window.syncStates['team-1'] })
    await page.getByRole('tab', { name: 'Overview' }).click()

    // A failure says what happened in plain words, offers one remedy, and keeps the code under Details.
    await page.evaluate(() => {
      window.paired[0].daemonStatus = 'stopped'
      window.paired[0].failure = { code: 'EXECUTOR_CONNECTION_FENCED', message: 'Executor connection is fenced.' }
    })
    await needs.getByText('Platform · UnlikeOtherAI is not connected').waitFor()
    await needs.getByText(/Another copy of this team connected to Nessie after this computer did/).waitFor()
    assert.equal(await card('Platform · UnlikeOtherAI').locator('.status-word').textContent(), 'Not connected')
    assert.equal(await page.locator('.need-failure').evaluate((node) => node.textContent.includes('EXECUTOR_CONNECTION_FENCED') && !node.querySelector('details').open), true)
    await shot('failure')
    await page.getByRole('button', { name: 'Connect again' }).click()
    await page.waitForFunction(() => window.remedies.length === 1)
    assert.deepEqual(await page.evaluate(() => window.remedies), [{ executorId: 'team-0', remedy: 'restartExecutor' }])
    await page.waitForFunction(() => !document.body.textContent.includes('is not connected'))
    // A pairing that Nessie never confirmed sends the person to Nessie, for the named team.
    await page.evaluate(() => { window.paired[0].failure = { code: 'ENROLLMENT_EXPIRED', message: 'No active executor enrollment is ready' } })
    await needs.getByRole('button', { name: 'Open Nessie' }).click()
    assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, { executorId: 'team-0' })
    // An unknown failure is quoted honestly.
    await page.evaluate(() => { window.paired[0].failure = { message: 'Something new went wrong.' } })
    await needs.getByText('Nessie refused that. What it said is under Details.').waitFor()
    assert.equal(await page.locator('.need-failure details p').textContent(), 'Something new went wrong.')
    await page.evaluate(() => { delete window.paired[0].failure })

    // Settings: switches that save when pressed, updates, notifications, help.
    await page.getByRole('tab', { name: 'Settings' }).click()
    assert.deepEqual(await page.locator('#tab-settings input[type=checkbox]').evaluateAll((inputs) => inputs.map((input) => input.id)),
      ['autostart', 'auto-restart', 'update-automatic'])
    assert.equal(await page.getByLabel('Restart a team if it stops').isChecked(), true)
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    await page.getByText('Version 1.0.0', { exact: true }).waitFor()
    await page.getByText('nessie-computer --help').waitFor()
    await page.getByLabel('Open Nessie Computer when I log in').check()
    await page.waitForFunction(() => window.enabled)
    await shot('settings')
    await page.getByRole('button', { name: 'Open logs folder' }).click()
    assert.equal(await callCount(page, 'executor_open_logs'), 1)
    // A save that fails says so beside its switch and puts the switch back.
    await page.evaluate(() => { window.failAutostart = 'The login item could not be written.' })
    // A plain click: the switch snaps back on failure, which `uncheck()` would report as a stuck control.
    await page.getByLabel('Open Nessie Computer when I log in').click()
    await page.locator('[data-error-for=autostart]').getByText('This setting wasn’t saved: The login item could not be written.').waitFor()
    assert.equal(await page.getByLabel('Open Nessie Computer when I log in').isChecked(), true)
    await page.evaluate(() => { window.failAutostart = null })
    // The footer's Open Nessie names the selected team.
    await page.locator('#open-nessie').click()
    assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, { executorId: 'team-1' })

    // Deep links open their exact place; Disconnect asks first.
    await page.evaluate(() => window.emitTray('tray://section/ai', { executorId: 'team-0' }))
    assert.equal(await page.getByRole('tab', { name: 'AI' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-0')
    await page.getByRole('heading', { name: 'AI for Platform · UnlikeOtherAI' }).waitFor()
    // The menus' "Add this computer…" opens the window straight onto a new code.
    const starts = await callCount(page, 'executor_pairing_start')
    await page.evaluate(() => window.emitTray('tray://connect'))
    await page.locator('#connect-dialog[open]').waitFor()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.equal(await callCount(page, 'executor_pairing_start'), starts + 1)
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { apiBaseUrl: 'https://api.nessie.works' })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.getElementById('connect-dialog').open)
    await page.evaluate(() => window.emitTray('tray://section/overview'))
    await card('Platform · UnlikeOtherAI').getByRole('button', { name: 'Disconnect…' }).click()
    assert.equal(await page.evaluate(() => document.activeElement.id), 'disconnect-cancel')
    assert.equal(await page.locator('#disconnect-title').textContent(), 'Disconnect Platform · UnlikeOtherAI?')
    await shot('disconnect')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('#team-cards .team-card').length === 1)
    assert.deepEqual((await lastCall(page, 'executor_remove')).args, { executorId: 'team-0' })
    assert.equal(await footer(), 'Platform · UnlikeOtherAI is disconnected from this computer.')
    assert.equal(await page.evaluate(() => window.restarts), 0, 'no removed bridge command was called')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // Czech: every word the shell owns, on the welcome and on a connected Overview.
  {
    const { context, page, errors, shot } = await open({ host: 'macos', locale: 'cs-CZ' })
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'cs')
    await page.getByText('Dokud tento počítač nepřidáte do týmu, nesdílí se nic.').waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Přehled' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#status-sentence').textContent(), 'Zatím není připojen žádný tým')
    await shot('welcome-cs')
    await page.getByRole('button', { name: 'Přidat tento počítač', exact: true }).first().click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.equal(await page.locator('#connect-title').textContent(), 'Přidat tento počítač')
    await page.locator('#pairing-instruction').getByText('V Nessie otevřete Počítače a zvolte Přidat počítač.').waitFor()
    assert.match(await page.locator('#pairing-time').textContent(), /^Vyprší za 4:[45]\d$/)
    await shot('connect-cs')
    await page.evaluate(() => window.claimInNessie())
    await page.locator('#connected-body').getByText('1 složka · aplikace UnlikeOtherAI, Claude Code, Codex, T3 Code · všechny místní aplikace · žádné weby').waitFor()
    assert.equal(await page.locator('#status-sentence').textContent(), 'Pracuje pro 1 tým')
    await page.locator('.team-card .status-word').getByText('Pracuje').waitFor()
    await shot('connected-cs')
    await page.getByRole('tab', { name: 'Nastavení' }).click()
    await page.getByText('Otevřít Nessie Computer po přihlášení').waitFor()
    await shot('settings-cs')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Every other locale renders its Overview and Settings without a missing word.
  for (const locale of ['en-US', 'de', 'es', 'fr', 'it']) {
    const { context, page, errors } = await open({ host: 'windows', locale, paired: 2 })
    await page.locator('#team-cards .team-card .team-summary').nth(1).waitFor()
    await showTab(page, 'settings')
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // A nessie-computer:// link that started the Windows app opens its section once; macOS has no such command and is not asked twice.
  {
    const context = await browser.newContext({ viewport: { width: 640, height: 680 }, locale: 'en-GB' })
    await context.addInitScript(() => { window.launchLink = { section: 'documents', executorId: 'team-1' } })
    const opened = await openConsole(browser, ui, { host: 'windows', paired: 2, sync: null, context })
    await opened.page.getByRole('heading', { name: 'Documents for Research · UnlikeOtherAI' }).waitFor()
    assert.equal(await opened.page.locator('#team-select').inputValue(), 'team-1')
    assert.equal(await callCount(opened.page, 'executor_launch_link'), 1)
    assert.deepEqual(opened.errors, [])
    journeys++
    await opened.context.close()
  }
  // On Windows a team's ChatGPT plans run on a second, service-owned connection: one card, one dropdown entry, its state on the team's card.
  {
    const { context, page, errors, shot } = await open({ host: 'windows', paired: 2 })
    await page.locator('#team-cards .team-card').nth(1).waitFor()
    await page.evaluate(() => window.claimPlanInNessie('team-0'))
    await page.locator('.team-card', { hasText: 'Platform · UnlikeOtherAI' }).getByText('ChatGPT plan connection: Working').waitFor()
    assert.equal(await page.locator('#team-cards .team-card').count(), 2)
    assert.equal(await page.locator('#status-sentence').textContent(), 'Working for 2 teams')
    await page.getByRole('tab', { name: 'Access' }).click()
    assert.deepEqual(await page.locator('#team-select option').evaluateAll((options) => options.map((option) => option.value)), ['team-0', 'team-1'])
    await page.getByRole('tab', { name: 'Overview' }).click()
    await page.evaluate(() => { window.paired[2].daemonStatus = 'stopped'; window.paired[2].failure = { message: 'Service connection lost.' } })
    await page.locator('#needs-you-list').getByText('Platform · UnlikeOtherAI — ChatGPT plan connection is not connected').waitFor()
    await shot('plan-connection')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Dark follows the OS; the same tokens, no white page.
  {
    const { context, page, errors, shot } = await open({ host: 'windows', dark: true, paired: 2 })
    await page.locator('#team-cards .team-card .team-audience-text').first().getByText('Agents: Jev').waitFor()
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
    await shot('overview-dark')
    await page.getByRole('button', { name: 'Add this computer', exact: true }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await shot('connect-dark')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.getElementById('connect-dialog').open)
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    await shot('settings-dark')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // The smallest window the apps allow: everything still fits and reads.
  for (const [locale, dark] of [['en-GB', false], ['cs-CZ', true]]) {
    const { context, page, errors, shot } = await open({ host: 'macos', locale, dark, size: 'minimum' })
    const suffix = `${locale === 'cs-CZ' ? '-cs' : ''}${dark ? '-dark' : ''}-min`
    await page.locator('#overview-welcome-connect').waitFor()
    await shot(`welcome${suffix}`)
    await page.locator('#overview-welcome-connect').click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await shot(`connect${suffix}`)
    await page.evaluate(() => window.claimInNessie())
    await page.locator('#overview-connected:not([hidden])').waitFor()
    await page.locator('#connected-body').getByText(/·/).waitFor()
    await shot(`connected${suffix}`)
    await page.getByRole('button', { name: /Done|Hotovo/, exact: true }).click()
    await page.getByRole('button', { name: /Add this computer|Přidat tento počítač/, exact: true }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.evaluate(() => window.claimInNessie())
    await page.waitForFunction(() => document.querySelectorAll('#team-cards .team-card').length === 2)
    await page.getByRole('button', { name: /Done|Hotovo/, exact: true }).click()
    await page.locator('#team-cards .team-card .team-audience-text').nth(1).getByText(/Jev/).waitFor()
    await shot(`overview-two-teams${suffix}`)
    await showTab(page, 'settings')
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    await shot(`settings${suffix}`)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  process.stdout.write(`${journeys} console shell journeys passed; pictures ${output}\n`)
}
