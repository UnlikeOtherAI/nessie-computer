// Shell journeys for the shared Nessie Computer console: welcome, Connect a
// team, the connected card, Overview with two teams, Needs you, a failure
// with its remedy, Settings, Czech and dark. Both hosts render the same document.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'

const lastCall = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).at(-1), command)
const calls = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).length, command)

export const verifyConsoleShell = async (browser, serve, output) => {
  let journeys = 0
  const open = async ({ host, locale = 'en-GB', colorScheme = 'light', paired = false, width = 640 }) => {
    const context = await browser.newContext({ viewport: { width, height: 720 }, locale, colorScheme })
    await installRendererHost(context, host, { paired })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'warning' && /Missing translation/.test(message.text())) errors.push(message.text()) })
    page.setDefaultTimeout(12000)
    await serve(page)
    await page.goto('http://localhost:5875/')
    return { context, page, errors, shot: (name) => page.screenshot({ path: join(output, `${host}-${name}.png`), fullPage: true }) }
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
    await page.getByText('Nothing is shared until you connect a team.').waitFor()
    assert.equal(await status(), 'No team connected yet')
    assert.equal(await page.locator('#team-row').isHidden(), true)
    assert.equal(await page.locator('#pause-all').isHidden(), true)
    assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).count(), 0)
    // Content text is selectable; controls are not.
    assert.equal(await page.locator('#overview-welcome-text').evaluate((node) => getComputedStyle(node).userSelect), 'text')
    assert.equal(await page.locator('#overview-welcome-connect').evaluate((node) => getComputedStyle(node).userSelect), 'none')
    await shot('welcome')
    // A team tab with nothing connected offers Connect a team instead of an empty page.
    await page.getByRole('tab', { name: 'Access' }).click()
    await page.locator('#no-team').waitFor()
    assert.equal(await page.locator('#team-row').isHidden(), true)
    // Arrow keys move between tabs.
    await page.getByRole('tab', { name: 'Access' }).focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true')

    // Connect a team asks for a code at once, with no address field in sight.
    await page.getByRole('button', { name: 'Connect a team', exact: true }).first().click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { replace: false, apiBaseUrl: 'https://api.nessie.works' })
    assert.equal(await page.locator('#pairing-server').isVisible(), false)
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'In Nessie, open Computers and choose Add a computer.')
    assert.equal(await page.getByRole('dialog').getByText(/fingerprint/i).count(), 0)
    assert.equal(await page.getByRole('dialog').locator('input[type=checkbox]').count(), 0)
    await page.getByRole('button', { name: 'Copy pairing code' }).click()
    assert.deepEqual((await lastCall(page, 'executor_copy_code')).args, { code: '01234567' })
    await page.getByRole('button', { name: 'Open Nessie to finish' }).click()
    assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, { apiBaseUrl: 'https://api.nessie.works', path: '/admin/computers?create=1&code=01234567' })
    await shot('connect')
    // An expired code stays visible, greyed, with Get a new code; checks continue meanwhile.
    await page.evaluate(() => { window.expiresAt = new Date(Date.now() - 1000).toISOString() })
    await page.getByRole('button', { name: 'Get a new code' }).waitFor()
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'This code has expired.')
    assert.equal(await page.locator('#pairing-code').textContent(), '01234567')
    assert.equal(await page.locator('#pairing-code').evaluate((node) => node.classList.contains('expired')), true)
    const checks = await calls(page, 'executor_pairing_status')
    await page.waitForFunction((before) => window.calls.filter((call) => call.command === 'executor_pairing_status').length > before, checks)
    await shot('connect-expired')
    await page.evaluate(() => { window.expiresAt = undefined; window.pairStatus = 'waiting' })
    await page.getByRole('button', { name: 'Get a new code' }).click()
    await page.waitForFunction(() => !document.getElementById('pairing-code').classList.contains('expired'))
    // Escape cancels the attempt rather than hiding a live code.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_pairing_cancel'))
    await page.waitForFunction(() => !document.getElementById('connect-dialog').open)
    // The organisation's own server sits behind one link; a refused address is reported beside it.
    await page.getByRole('button', { name: 'Connect a team', exact: true }).first().click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.locator('#connect-advanced summary').click()
    await page.locator('#pairing-server').fill('http://nessie.example.com')
    await page.getByRole('button', { name: 'Get a code for this server' }).click()
    await page.locator('#pairing-server-error').getByText('The server address must start with https://.').waitFor()
    assert.equal(await page.locator('#pairing-server').getAttribute('aria-invalid'), 'true')
    await page.locator('#pairing-server').fill('https://nessie.example.com')
    await page.getByRole('button', { name: 'Get a code for this server' }).click()
    await page.waitForFunction(() => window.pairServer === 'https://nessie.example.com')
    assert.equal(await page.locator('#pairing-server-error').isHidden(), true)
    // The claim in Nessie finishes it: the dialog closes and Overview shows what the team may use.
    await page.evaluate(() => window.claimInNessie())
    await page.locator('#overview-connected:not([hidden])').waitFor()
    assert.equal(await page.locator('#connect-dialog').evaluate((dialog) => dialog.open), false)
    assert.equal(await page.locator('#connected-title').textContent(), 'Connected to Platform · UnlikeOtherAI')
    await page.locator('#connected-body').getByText('Agents in this team can now use: 2 folders · UnlikeOtherAI apps, Claude Code, Codex, T3 Code · all local apps · no websites.').waitFor()
    assert.equal(await calls(page, 'executor_notify'), 0)
    assert.equal(await status(), 'Working for 1 team')
    await shot('connected')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    assert.equal(await page.locator('#overview-connected').isHidden(), true)

    // Two teams, one paused: cards name the team, its status, its access and who may send work.
    await page.getByRole('button', { name: 'Connect a team', exact: true }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.evaluate(() => window.claimInNessie())
    await page.waitForFunction(() => document.querySelectorAll('#team-cards .team-card').length === 2)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    const card = (team) => page.locator('.team-card', { hasText: team })
    await card('Research · UnlikeOtherAI').locator('.team-audience-text').getByText('Agents: Jev · People: Ondrej').waitFor()
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
    await page.getByRole('button', { name: 'Resume all', exact: true }).click()
    await page.getByRole('button', { name: 'Pause all', exact: true }).waitFor()
    assert.equal(await status(), 'Working for 2 teams')
    // Change access lands on Access with that team selected.
    await card('Research · UnlikeOtherAI').getByRole('button', { name: 'Change access' }).click()
    assert.equal(await page.getByRole('tab', { name: 'Access' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-row').isVisible(), true)
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
    assert.equal(await page.locator('#team-select option', { hasText: 'Research · UnlikeOtherAI' }).count(), 1)
    await page.getByRole('tab', { name: 'Settings' }).click()
    assert.equal(await page.locator('#team-row').isHidden(), true)
    await page.getByRole('tab', { name: 'Overview' }).click()

    // Needs you: a program request, and Documents waiting for a decision.
    await page.evaluate(() => {
      window.requests = [{ executorId: 'team-0', id: 'req-1', program: 'git', args: ['push', 'origin', 'main'], agentName: 'Jev',
        requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90000).toISOString() }]
      window.paired[0].pendingProgramRequests = 1
      window.syncStates['team-1'] = { executorId: 'team-1', enabled: true, paused: false, state: 'needs_attention',
        counts: { openConflicts: 1, errors: 0, heldDeletes: 0 }, conflicts: [{ clientConflictId: 'c1' }], heldDeletes: null }
    })
    const needs = page.locator('#needs-you-list')
    await needs.getByText('Jev wants to run git').waitFor()
    await needs.getByText('Documents for Research · UnlikeOtherAI need you: files to check').waitFor()
    assert.equal(await status(), 'Needs you: Jev wants to run git')
    assert.equal(await card('Platform · UnlikeOtherAI').locator('.status-word').textContent(), 'Needs you')
    assert.equal(await page.getByRole('button', { name: 'Allow once' }).count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Don’t allow' }).count(), 1)
    await shot('needs-you')
    await page.getByRole('button', { name: 'Always allow git' }).click()
    await page.waitForFunction(() => window.policies['team-0'].allowlist.includes('git *'))
    assert.deepEqual(await page.evaluate(() => window.answers), [{ id: 'req-1', answer: 'always' }])
    await page.waitForFunction(() => !document.body.textContent.includes('Jev wants to run git'))
    await page.getByRole('button', { name: 'Open Documents' }).click()
    assert.equal(await page.getByRole('tab', { name: 'Documents' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
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
    assert.deepEqual(await page.evaluate(() => window.remedies), [{ executorId: 'team-0', remedy: 'restart' }])
    await page.waitForFunction(() => !document.body.textContent.includes('is not connected'))
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
    assert.equal(await calls(page, 'executor_open_logs'), 1)
    // A save that fails says so beside its switch and puts the switch back.
    await page.evaluate(() => { window.failAutostart = 'The login item could not be written.' })
    await page.getByLabel('Open Nessie Computer when I log in').uncheck()
    await page.locator('[data-error-for=autostart]').getByText('This setting wasn’t saved: The login item could not be written.').waitFor()
    assert.equal(await page.getByLabel('Open Nessie Computer when I log in').isChecked(), true)
    await page.evaluate(() => { window.failAutostart = null })
    assert.equal(await calls(page, 'executor_notify'), 0)

    // Deep links open their exact place; Disconnect asks first.
    await page.evaluate(() => window.emitTray('tray://section/ai', { executorId: 'team-0' }))
    assert.equal(await page.getByRole('tab', { name: 'AI' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-0')
    await page.evaluate(() => window.emitTray('tray://connect'))
    await page.locator('#connect-dialog[open]').waitFor()
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
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // Czech: every word the shell owns, on the welcome and on a connected Overview.
  {
    const { context, page, errors, shot } = await open({ host: 'macos', locale: 'cs-CZ' })
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'cs')
    await page.getByText('Dokud nepřipojíte tým, nesdílí se nic.').waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Přehled' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#status-sentence').textContent(), 'Zatím není připojen žádný tým')
    await shot('welcome-cs')
    await page.getByRole('button', { name: 'Připojit tým', exact: true }).first().click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.getByText('V Nessie otevřete Počítače a zvolte Přidat počítač.').waitFor()
    await shot('connect-cs')
    await page.evaluate(() => window.claimInNessie())
    await page.locator('#connected-body').getByText('2 složky · aplikace UnlikeOtherAI, Claude Code, Codex, T3 Code · všechny místní aplikace · žádné weby').waitFor()
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
  // Every other locale renders its welcome without a missing word.
  for (const locale of ['en-US', 'de', 'es', 'fr', 'it']) {
    const { context, page, errors } = await open({ host: 'windows', locale, paired: true })
    await page.locator('#team-cards .team-card .team-summary').waitFor()
    await page.getByRole('tab', { name: /./ }).last().click()
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // Dark follows the OS; the same tokens, no white page.
  {
    const { context, page, errors, shot } = await open({ host: 'windows', colorScheme: 'dark', paired: true })
    await page.locator('#team-cards .team-card .team-audience-text').getByText('Agents: Jev').waitFor()
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
    await shot('overview-dark')
    await page.getByRole('button', { name: 'Connect a team', exact: true }).click()
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
  process.stdout.write(`${journeys} console shell journeys passed; screenshots ${output}\n`)
}
