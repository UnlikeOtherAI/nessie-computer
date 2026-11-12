// Shell journeys for the shared Nessie Computer console: the pairing code a
// new install opens on, the team dropdown with "＋ Add another team", the Needs
// you strip, a failure with its remedy, Settings with the team's Pause and
// Disconnect, the "?" control, Czech, dark and the smallest window. Both hosts
// render the same document. Assertions only.
import assert from 'node:assert/strict'
import { syncCases } from './sync-fixtures.mjs'
import { TABS, assertFits, callCount, checkHelp, lastCall, openConsole, selectTeam, showTab } from './renderer-page.mjs'

const ADD = '+'
const options = (page) => page.locator('#team-select option').evaluateAll((nodes) => nodes.map((option) => [option.value, option.textContent]))
const selected = (page, name) => page.getByRole('tab').nth(TABS.indexOf(name)).getAttribute('aria-selected')
const codeShowing = (page) => page.waitForFunction(() => document.getElementById('connect-dialog').open && document.getElementById('pairing-code').textContent === '01234567')
const dialogClosed = (page) => page.waitForFunction(() => !document.getElementById('connect-dialog').open)
const addTeam = (page) => page.locator('#team-select').selectOption(ADD)

export const verifyConsoleShell = async (browser, ui) => {
  let journeys = 0
  const open = (options) => openConsole(browser, ui, { sync: null, ...options })

  for (const host of ['windows', 'macos']) {
    const { context, page, errors } = await open({ host })
    const footer = () => page.locator('#save-status').textContent()

    // A new install: four tabs, the dropdown holds only "＋ Add another team", and the window opens straight on a code.
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-GB')
    assert.equal(await page.title(), 'Nessie Computer')
    assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Access', 'Documents', 'AI', 'Settings'])
    assert.equal(await selected(page, 'access'), 'true')
    assert.ok((await page.locator('.tabs').boundingBox()).height <= 32)
    assert.deepEqual(await options(page), [[ADD, '＋ Add another team']])
    assert.equal(await page.locator('#needs-you-list').isHidden(), true)
    await codeShowing(page)
    assert.equal(await page.locator('#connect-title').textContent(), 'Add another team')
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { apiBaseUrl: 'https://api.nessie.works' })
    assert.equal(await page.locator('#pairing-server').isVisible(), false)
    assert.equal(await page.locator('#connect-advanced').evaluate((details) => details.open), false)
    assert.equal(await page.locator('#pairing-server').inputValue(), '')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'connect-title')
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Add this computer|Overview|Now working|Who can send work/)
    // The countdown runs to the server's expiresAt (five minutes from the hosted Nessie).
    assert.match(await page.locator('#pairing-time').textContent(), /^Expires in 4:[45]\d$/)
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'Enter this code in Nessie under Computers › Add a computer.')
    assert.equal(await page.getByRole('dialog').getByText(/fingerprint/i).count(), 0)
    assert.equal(await page.getByRole('dialog').locator('input[type=checkbox]').count(), 0)
    await page.getByRole('button', { name: 'Copy pairing code' }).click()
    assert.deepEqual((await lastCall(page, 'executor_copy_code')).args, { code: '01234567' })
    // The host builds the URL and adds the code itself (§5.1): the page passes no path.
    await page.getByRole('button', { name: 'Open Nessie to finish' }).click()
    assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, {})
    await assertFits(page, `${host} code`)
    // An expired code stays visible, greyed, with Get a new code; checks continue meanwhile.
    await page.evaluate(() => { window.expiresAt = new Date(Date.now() - 1000).toISOString() })
    await page.getByRole('button', { name: 'Get a new code' }).waitFor()
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'This code has expired.')
    assert.equal(await page.locator('#pairing-code').textContent(), '01234567')
    assert.equal(await page.locator('#pairing-code').evaluate((node) => node.classList.contains('expired')), true)
    const checks = await callCount(page, 'executor_pairing_status')
    await page.waitForFunction((before) => window.calls.filter((call) => call.command === 'executor_pairing_status').length > before, checks)
    await page.evaluate(() => { window.expiresAt = undefined; window.pairStatus = 'waiting' })
    await page.getByRole('button', { name: 'Get a new code' }).click()
    await page.waitForFunction(() => !document.getElementById('pairing-code').classList.contains('expired'))
    // Escape cancels the attempt rather than hiding a live code; with no team the tab offers the one button.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_pairing_cancel'))
    await dialogClosed(page)
    await page.locator('#no-team').waitFor()
    assert.equal(await page.locator('#no-team-connect').textContent(), 'Add another team')
    assert.equal(await page.locator('#no-team p').count(), 0, 'no sentence: one button')
    await assertFits(page, `${host} no team`)
    // Cancel closes the dialog even when the computer cannot end the attempt; the window says why.
    await page.locator('#no-team-connect').click()
    await codeShowing(page)
    await page.evaluate(() => { window.cancelFailure = 'The pairing folder could not be written.' })
    await page.locator('#pairing-stop').click()
    await dialogClosed(page)
    await page.locator('#error').getByText('The pairing folder could not be written.').waitFor()
    // That attempt is still on the computer: Add another team shows its code again, and Cancel ends it.
    await page.evaluate(() => { window.cancelFailure = null })
    await page.locator('#no-team-connect').click()
    await codeShowing(page)
    assert.equal(await page.locator('#error').isHidden(), true)
    await page.locator('#pairing-stop').click()
    await dialogClosed(page)
    // A request Nessie refuses says why, with Try again; it never opens the server address.
    await page.evaluate(() => { window.pairingFailure = 'Nessie couldn’t finish this step. Check your connection and try again.' })
    await page.locator('#no-team-connect').click()
    await page.locator('#pairing-error').getByText('Nessie couldn’t finish this step. Check your connection and try again.').waitFor()
    assert.equal(await page.locator('#connect-advanced').evaluate((details) => details.open), false)
    assert.equal(await page.locator('#connect-progress').isHidden(), true)
    assert.equal(await page.locator('#pairing-open-nessie').isHidden(), true)
    await page.evaluate(() => { window.pairingFailure = null })
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await codeShowing(page)
    assert.equal(await page.locator('#pairing-error').isHidden(), true)
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { apiBaseUrl: 'https://api.nessie.works' })
    // The organisation's own server sits behind one link, empty until typed, its explanation behind "?"; a refused address is reported beside it.
    await page.locator('#connect-advanced summary').click()
    assert.equal(await page.locator('#pairing-server').inputValue(), '')
    assert.equal(await page.locator('#pairing-server').getAttribute('placeholder'), 'https://nessie.example.com')
    assert.equal(await page.locator('#connect-advanced p.hint').count(), 0)
    assert.match(await checkHelp(page, 'pairing-server-help'), /address your administrator gave you/)
    await page.locator('#pairing-server').fill('http://nessie.example.com')
    const cancelsBefore = await callCount(page, 'executor_pairing_cancel')
    await page.getByRole('button', { name: 'Get code', exact: true }).click()
    await page.locator('#pairing-server-error').getByText('The server address must start with https://.').waitFor()
    assert.equal(await page.locator('#pairing-server').getAttribute('aria-invalid'), 'true')
    // A typo costs nothing: the hosted code still waits, and is still shown.
    assert.equal(await callCount(page, 'executor_pairing_cancel'), cancelsBefore)
    assert.equal(await page.evaluate(() => window.pairStatus), 'waiting')
    assert.equal(await page.locator('#pairing-code').textContent(), '01234567')
    assert.equal(await page.locator('#pairing-open-nessie').isVisible(), true)
    await assertFits(page, `${host} own server`)
    await page.locator('#pairing-server').fill('https://nessie.example.com')
    await page.getByRole('button', { name: 'Get code', exact: true }).click()
    await page.waitForFunction(() => window.pairServer === 'https://nessie.example.com')
    assert.equal(await page.locator('#pairing-server-error').isHidden(), true)
    // Only an accepted address replaces the hosted code.
    assert.equal(await callCount(page, 'executor_pairing_cancel'), cancelsBefore + 1)
    // Asked again while that code waits, the dialog keeps its code and names the server it belongs to.
    await page.locator('#pairing-server').fill('')
    const startsBefore = await callCount(page, 'executor_pairing_start')
    await page.evaluate(() => window.emitTray('tray://connect'))
    await page.waitForFunction(() => document.getElementById('pairing-server').value === 'https://nessie.example.com')
    assert.equal(await page.locator('#connect-advanced').evaluate((details) => details.open), true)
    assert.equal(await callCount(page, 'executor_pairing_start'), startsBefore)
    // The claim in Nessie finishes it: the dialog closes, the team is selected and its Access tab shows.
    await page.evaluate(() => window.claimInNessie())
    await dialogClosed(page)
    await page.locator('#access-body:not([hidden])').waitFor()
    assert.equal(await selected(page, 'access'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-0')
    assert.deepEqual(await options(page), [['team-0', 'Platform · UnlikeOtherAI'], [ADD, '＋ Add another team']])
    assert.equal(await footer(), 'Connected to Platform · UnlikeOtherAI.')
    await assertFits(page, `${host} connected`)

    // The dropdown's last entry starts pairing at once; the second team lands selected.
    await addTeam(page)
    await codeShowing(page)
    assert.equal(await page.locator('#team-select').inputValue(), 'team-0', 'the dropdown goes back to the team while the code shows')
    await page.evaluate(() => window.claimInNessie())
    await dialogClosed(page)
    await page.waitForFunction(() => document.getElementById('team-select').value === 'team-1')
    assert.deepEqual(await options(page), [['team-0', 'Platform · UnlikeOtherAI'], ['team-1', 'Research · UnlikeOtherAI'], [ADD, '＋ Add another team']])

    // Settings: the selected team first — its status word, Pause/Resume, Disconnect… — then the computer.
    await showTab(page, 'settings')
    assert.equal(await page.locator('#settings-team-title').textContent(), 'Working')
    assert.ok(await page.evaluate(() => document.getElementById('settings-team').compareDocumentPosition(document.getElementById('autostart')) & Node.DOCUMENT_POSITION_FOLLOWING))
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    assert.deepEqual((await lastCall(page, 'executor_set_paused')).args, { executorId: 'team-1', paused: true })
    assert.equal(await page.locator('#settings-team-title').textContent(), 'Paused')
    assert.equal(await footer(), 'Paused until you resume.')
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor()
    assert.deepEqual((await lastCall(page, 'executor_set_paused')).args, { executorId: 'team-1', paused: false })
    assert.equal(await footer(), 'Working again.')
    // A team another app, the command line or a scheduled task runs is working there, never "Not connected".
    await page.evaluate(() => { window.paired[1].daemonStatus = 'running elsewhere' })
    await page.locator('#settings-team-title').getByText('Working in another app').waitFor()
    await page.evaluate(() => { window.paired[1].daemonStatus = 'running' })
    await page.locator('#settings-team-title').getByText('Working', { exact: true }).waitFor()
    // The computer: switches that save when pressed, updates and logs; explanations behind "?", no hint lines, one version line.
    assert.deepEqual(await page.locator('#tab-settings input[type=checkbox]').evaluateAll((inputs) => inputs.map((input) => input.id)),
      ['autostart', 'auto-restart', 'update-automatic'])
    assert.equal(await page.locator('#tab-settings p.hint, #tab-settings h2:not(#update-title)').count(), 0)
    assert.equal(await page.getByLabel('Restart a team if it stops').isChecked(), true)
    assert.equal(await page.getByLabel('Restart a team if it stops').getAttribute('aria-describedby'), await page.locator('#auto-restart-help .help-tip').getAttribute('id'))
    assert.equal(await checkHelp(page, 'auto-restart-help'), 'A team that stops without you pausing it is started again.')
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    assert.equal(await page.getByText('1.0.0', { exact: true }).count(), 1, 'the version is said once')
    assert.match(await checkHelp(page, 'update-hint'), /Updates wait for work to finish/)
    assert.equal(await page.getByText('nessie-computer --help').isVisible(), false, 'the terminal note sits behind "?"')
    assert.match(await checkHelp(page, 'open-logs-help'), /nessie-computer --help/)
    await page.getByLabel('Open Nessie Computer when I log in').check()
    await page.waitForFunction(() => window.enabled)
    await assertFits(page, `${host} settings`)
    await page.getByRole('button', { name: 'Open logs folder' }).click()
    assert.equal(await callCount(page, 'executor_open_logs'), 1)
    // A save that fails says so beside its switch and puts the switch back.
    await page.evaluate(() => { window.failAutostart = 'The login item could not be written.' })
    await page.getByLabel('Open Nessie Computer when I log in').click()
    await page.locator('[data-error-for=autostart]').getByText('Not saved: The login item could not be written.').waitFor()
    assert.equal(await page.getByLabel('Open Nessie Computer when I log in').isChecked(), true)
    await page.evaluate(() => { window.failAutostart = null })
    // The footer's Open Nessie names the selected team.
    await page.locator('#open-nessie').click()
    assert.deepEqual((await lastCall(page, 'executor_open_nessie')).args, { executorId: 'team-1' })

    // Needs you: a strip under the dropdown, on every tab — a program request answered inline, Documents waiting for a decision.
    const attention = { ...syncCases(host).find((entry) => entry.name === 'claims-up-to-date-with-conflict').state, executorId: 'team-1' }
    await page.evaluate((state) => {
      window.requests = [{ executorId: 'team-0', id: 'req-1', program: 'git', args: ['push', 'origin', 'main'], agentName: 'Jev',
        requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90000).toISOString() }]
      window.paired[0].pendingProgramRequests = 1
      window.syncStates['team-1'] = state
    }, attention)
    const needs = page.locator('#needs-you-list')
    await needs.getByText('Jev wants to run git').waitFor()
    await needs.getByText('Documents for Research · UnlikeOtherAI: files to check').waitFor()
    assert.equal(await selected(page, 'settings'), 'true', 'the strip shows without leaving the tab')
    assert.ok(await page.evaluate(() => document.getElementById('needs-you-list').compareDocumentPosition(document.getElementById('tablist')) & Node.DOCUMENT_POSITION_FOLLOWING), 'under the dropdown, above the tabs')
    assert.equal(await page.getByRole('button', { name: 'Allow once' }).count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Don’t allow' }).count(), 1)
    await assertFits(page, `${host} needs you`)
    await page.getByRole('button', { name: 'Always allow git' }).click()
    await page.waitForFunction(() => window.teams['team-0'].policy.allowlist.includes('git *'))
    assert.deepEqual(await page.evaluate(() => window.answers), [{ id: 'req-1', answer: 'always' }])
    await page.waitForFunction(() => !document.body.textContent.includes('Jev wants to run git'))
    await page.getByRole('button', { name: 'Open Documents' }).click()
    assert.equal(await selected(page, 'documents'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
    await page.waitForFunction(() => document.getElementById('documents-state-text').textContent === 'Needs your attention')
    await page.evaluate(() => { delete window.syncStates['team-1'] })
    await page.waitForFunction(() => document.getElementById('needs-you-list').hidden)

    // A failure says what happened in plain words, offers one remedy, and keeps the code under Details.
    await page.evaluate(() => {
      window.paired[0].daemonStatus = 'stopped'
      window.paired[0].failure = { code: 'EXECUTOR_CONNECTION_FENCED', message: 'Executor connection is fenced.' }
    })
    await needs.getByText('Platform · UnlikeOtherAI is not connected').waitFor()
    await needs.getByText(/Another copy of this team connected to Nessie after this computer did/).waitFor()
    assert.equal(await page.locator('.need-failure').evaluate((node) => node.textContent.includes('EXECUTOR_CONNECTION_FENCED') && !node.querySelector('details').open), true)
    await selectTeam(page, 'team-0')
    await showTab(page, 'settings')
    assert.equal(await page.locator('#settings-team-title').textContent(), 'Not connected')
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
    // A refused native launch reads as words, its code under Details, with no button: the computer retries it.
    await page.evaluate(() => { window.paired[0].failure = { message: '{"code":"EXECUTOR_MANAGED_RELEASE_REJECTED","status":"rejected"}' } })
    await needs.getByText('Nessie Computer can’t start this until its update finishes.').waitFor()
    assert.equal(await page.locator('.need-failure button').count(), 0)
    assert.equal(await page.locator('.need-failure details p').textContent(), 'EXECUTOR_MANAGED_RELEASE_REJECTED')
    await page.evaluate(() => { delete window.paired[0].failure })
    await page.waitForFunction(() => document.getElementById('needs-you-list').hidden)

    // Deep links: a section with a team, the window as it was with a team, and Add another team.
    await page.evaluate(() => window.emitTray('tray://section/ai', { executorId: 'team-1' }))
    assert.equal(await selected(page, 'ai'), 'true')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
    await page.evaluate(() => window.emitTray('tray://open', { executorId: 'team-0' }))
    assert.equal(await selected(page, 'ai'), 'true', 'tray://open keeps the tab')
    assert.equal(await page.locator('#team-select').inputValue(), 'team-0')
    const starts = await callCount(page, 'executor_pairing_start')
    await page.evaluate(() => window.emitTray('tray://connect'))
    await codeShowing(page)
    assert.equal(await callCount(page, 'executor_pairing_start'), starts + 1)
    await page.keyboard.press('Escape')
    await dialogClosed(page)
    // Arrow keys move between tabs.
    await page.getByRole('tab').nth(TABS.indexOf('ai')).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await selected(page, 'settings'), 'true')

    // Disconnect, from Settings, asks first; the dropdown loses the team.
    await page.getByRole('button', { name: 'Disconnect…' }).click()
    assert.equal(await page.evaluate(() => document.activeElement.id), 'disconnect-cancel')
    assert.equal(await page.locator('#disconnect-title').textContent(), 'Disconnect Platform · UnlikeOtherAI?')
    assert.equal(await page.locator('#disconnect-body').textContent(), 'Agents lose access to this computer. Unapproved file changes here are deleted. Your own files stay.')
    await assertFits(page, `${host} disconnect`)
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('#team-select option').length === 2)
    assert.deepEqual((await lastCall(page, 'executor_remove')).args, { executorId: 'team-0' })
    assert.equal(await page.locator('#team-select').inputValue(), 'team-1')
    assert.equal(await footer(), 'Platform · UnlikeOtherAI is disconnected from this computer.')
    assert.equal(await page.evaluate(() => window.restarts), 0, 'no removed bridge command was called')
    // The window reopens on the tab last used.
    await page.reload()
    await page.getByRole('tab').nth(TABS.indexOf('settings')).waitFor()
    assert.equal(await selected(page, 'settings'), 'true')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // Czech: every word the shell owns, from the first code to Settings.
  {
    const { context, page, errors } = await open({ host: 'macos', locale: 'cs-CZ' })
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'cs')
    assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Přístup', 'Dokumenty', 'AI', 'Nastavení'])
    assert.deepEqual(await options(page), [[ADD, '＋ Přidat další tým']])
    await codeShowing(page)
    assert.equal(await page.locator('#connect-title').textContent(), 'Přidat další tým')
    await page.locator('#pairing-instruction').getByText('Zadejte tento kód v Nessie v části Počítače › Přidat počítač.').waitFor()
    assert.match(await page.locator('#pairing-time').textContent(), /^Vyprší za 4:[45]\d$/)
    await page.evaluate(() => window.claimInNessie())
    await dialogClosed(page)
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Připojeno k týmu Platform · UnlikeOtherAI.')
    await showTab(page, 'settings')
    await page.getByText('Otevřít Nessie Computer po přihlášení').waitFor()
    assert.equal(await page.locator('#settings-team-title').textContent(), 'Pracuje')
    await assertFits(page, 'cs settings')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Every other locale renders Access and Settings without a missing word.
  for (const locale of ['en-US', 'de', 'es', 'fr', 'it']) {
    const { context, page, errors } = await open({ host: 'windows', locale, paired: 2 })
    await page.locator('#access-body:not([hidden])').waitFor()
    await assertFits(page, `${locale} access`)
    await showTab(page, 'settings')
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    await assertFits(page, `${locale} settings`)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // A nessie-computer:// link that started the Windows app opens its section once; macOS has no such command and is not asked twice.
  {
    const context = await browser.newContext({ viewport: { width: 640, height: 680 }, locale: 'en-GB' })
    await context.addInitScript(() => { window.launchLink = { section: 'documents', executorId: 'team-1' } })
    const opened = await openConsole(browser, ui, { host: 'windows', paired: 2, sync: null, context })
    await opened.page.waitForFunction(() => document.getElementById('documents-switch-label').textContent === 'Keep a copy of Research · UnlikeOtherAI’s documents on this computer')
    assert.equal(await opened.page.locator('#team-select').inputValue(), 'team-1')
    assert.equal(await callCount(opened.page, 'executor_launch_link'), 1)
    assert.deepEqual(opened.errors, [])
    journeys++
    await opened.context.close()
  }
  // On Windows a team's ChatGPT plans run on a second, service-owned connection: one dropdown entry; its failure names the team.
  {
    const { context, page, errors } = await open({ host: 'windows', paired: 2 })
    await page.locator('#access-body:not([hidden])').waitFor()
    await page.evaluate(() => window.claimPlanInNessie('team-0'))
    await page.waitForFunction(() => window.paired.length === 3)
    await page.waitForTimeout(600)
    assert.deepEqual((await options(page)).map(([value]) => value), ['team-0', 'team-1', ADD])
    await page.evaluate(() => { window.paired[2].daemonStatus = 'stopped'; window.paired[2].failure = { message: 'Service connection lost.' } })
    await page.locator('#needs-you-list').getByText('Platform · UnlikeOtherAI — ChatGPT plan connection is not connected').waitFor()
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Dark follows the OS; the same tokens, no white page.
  {
    const { context, page, errors } = await open({ host: 'windows', dark: true, paired: 2 })
    await page.locator('#access-body:not([hidden])').waitFor()
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
    await addTeam(page)
    await codeShowing(page)
    await assertFits(page, 'dark code')
    await page.keyboard.press('Escape')
    await dialogClosed(page)
    await showTab(page, 'settings')
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    await checkHelp(page, 'update-hint')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Names come from the rows (docs/team-names.md): a team that has never had one
  // says so and needs nobody; the next view's name replaces it, and the console
  // never asks the host to look a team up.
  for (const host of ['windows', 'macos']) {
    const { context, page, errors } = await open({ host, paired: 1, unnamed: true })
    await page.locator('#access-body:not([hidden])').waitFor()
    assert.equal(await page.locator('#team-select option').first().textContent(), 'Team name not available yet')
    assert.equal(await page.locator('#needs-you-list li').count(), 0, 'an unnamed team needs nobody')
    await page.evaluate(() => {
      window.paired[0].names = { organizationName: 'UnlikeOtherAI', teamName: 'Revenue', apiBaseUrl: 'https://api.nessie.works' }
    })
    await page.evaluate(() => window.nc.team.refresh())
    await page.waitForFunction(() => document.querySelector('#team-select option').textContent === 'Revenue · UnlikeOtherAI')
    assert.equal(await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_pairing_status'
      && call.args?.executorId).length), 0, 'no per-team name lookups')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // 9 November, Mac: a code from October reopened Add another team at every
  // launch, and neither Cancel nor Get a new code could close it. A code that
  // ran out while the window was closed has ended: the window opens on the team.
  for (const host of ['windows', 'macos']) {
    const { context, page, errors } = await open({ host, paired: 1, pairStatus: 'expired' })
    await page.locator('#access-body:not([hidden])').waitFor()
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_pairing_status'))
    assert.equal(await page.locator('#connect-dialog').evaluate((dialog) => dialog.open), false)
    assert.equal(await page.locator('#team-select').inputValue(), 'team-0')
    // Add another team asks for a fresh code rather than showing the old one.
    const starts = await callCount(page, 'executor_pairing_start')
    await addTeam(page)
    await codeShowing(page)
    assert.equal(await callCount(page, 'executor_pairing_start'), starts + 1)
    assert.equal(await page.locator('#pairing-code').evaluate((node) => node.classList.contains('expired')), false)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // 9 November, Mac: the installed runtime refused `describe`, the team vanished,
  // and the window opened Add another team by itself. A paired team the runtime
  // refuses is listed instead, its tabs say why in words, and once it reads
  // again the window picks it up with no click.
  {
    const { context, page, errors } = await open({ host: 'macos', unreadable: true })
    await page.getByText('Couldn’t load access for Team name not available yet. Nessie Computer can’t start this until its update finishes.').waitFor()
    assert.equal(await page.locator('dialog[open]').count(), 0, 'a paired team never opens Add another team')
    assert.deepEqual(await page.locator('#team-select option').allTextContents(), ['Team name not available yet', '＋ Add another team'])
    assert.doesNotMatch(await page.locator('main').textContent(), /EXECUTOR_|"status"/)
    await page.evaluate(() => {
      window.paired = [{ executorId: 'team-0', daemonStatus: 'running', paused: false, pendingProgramRequests: 0,
        names: { organizationName: 'UnlikeOtherAI', teamName: 'Platform', apiBaseUrl: 'https://api.nessie.works' } }]
      window.teams['team-0'] = { folders: [{ name: 'nessie', path: '/Users/person/Nessie' }], policy: { mode: 'allowlist',
        allowlist: [], denylist: [], trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true } },
      existingSessions: true, allowedOrigins: [], browserConfigured: false, mcpServers: [] }
      window.failDescribe = null
    })
    await page.waitForFunction(() => document.querySelector('#team-select option').textContent === 'Platform · UnlikeOtherAI')
    await page.locator('#access-body:not([hidden])').waitFor()
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // The smallest window the apps allow: everything still fits and reads, "?" tips included.
  for (const [locale, dark] of [['en-GB', false], ['cs-CZ', true]]) {
    const { context, page, errors } = await open({ host: 'macos', locale, dark, size: 'minimum' })
    await codeShowing(page)
    await assertFits(page, `${locale} minimum code`)
    await page.evaluate(() => window.claimInNessie())
    await dialogClosed(page)
    await page.locator('#access-body:not([hidden])').waitFor()
    await addTeam(page)
    await codeShowing(page)
    await page.evaluate(() => window.claimInNessie())
    await dialogClosed(page)
    await page.waitForFunction(() => document.querySelectorAll('#team-select option').length === 3)
    await assertFits(page, `${locale} minimum access`)
    await checkHelp(page, 'access-folders-help')
    await showTab(page, 'settings')
    await page.locator('#update-version').getByText('1.0.0', { exact: true }).waitFor()
    await checkHelp(page, 'update-hint')
    await assertFits(page, `${locale} minimum settings`)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  process.stdout.write(`${journeys} console shell journeys passed\n`)
}
