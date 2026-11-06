// Both native hosts render this exact document. Only native IPC is replaced.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { installRendererHost } from './renderer-host.mjs'
import { verifyChatgptLocales } from './chatgpt-renderer.mjs'
import { verifyPersonalPlanPairing } from './personal-pairing-renderer.mjs'
import { verifySyncTab } from './sync-renderer.mjs'
import { verifySoftwareUpdates } from './updates-renderer.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ui = join(root, 'packages/executor-console')
const output = join(root, '.artifacts/executor-console')
const files = ['index.html', 'style.css', 'native.js', 'autosave.js', 'main.js', 'chatgpt-words.js', 'chatgpt.js',
  'teams.js', 'team-drafts.js', 'pairing-words.js', 'pairing.js', 'permissions.js',
  'sync-reasons-words.js', 'sync-words.js', 'sync.js', 'updates-words.js', 'updates.js']
await mkdir(output, { recursive: true })
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true })
const lastCall = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).at(-1), command)
try {
  if (process.argv.includes('--updates-only') || process.argv.includes('--updates-bootstrap-only')
    || process.argv.some((arg) => arg.startsWith('--updates-before='))) {
    await verifySoftwareUpdates(browser, ui, files, root)
    process.exit(0)
  }
  if (process.argv.includes('--sync-only')) {
    await verifySyncTab(browser, ui, files, root)
    process.exit(0)
  }
  await verifySyncTab(browser, ui, files, root)
  await verifyChatgptLocales(browser, ui, output, files)
  await verifyPersonalPlanPairing(browser, ui, output, files)
  for (const host of ['windows', 'macos']) {
    const context = await browser.newContext({ viewport: { width: 640, height: 680 } })
    await installRendererHost(context, host)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(12000)
    await page.route('http://localhost:5875/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      assert.ok(files.includes(file), file)
      await route.fulfill({ body: await readFile(join(ui, file)), contentType: file.endsWith('.js')
        ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
    })
    await page.goto('http://localhost:5875/')
    const status = () => page.locator('#save-status').textContent()
    // The tab bar is one compact row, exposed as tabs.
    assert.ok((await page.locator('.tabs').boundingBox()).height <= 32)
    assert.equal(await page.getByRole('tab', { name: 'Teams' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#team-row').isHidden(), true)
    await page.screenshot({ path: join(output, `${host}-empty.png`), fullPage: true })

    // Adding a team happens in a dialog, with no folder to choose; its errors stay inside it.
    await page.getByRole('button', { name: 'Add team', exact: true }).click()
    assert.equal(await page.locator('#pairing-personal-plan-choice').isHidden(), host !== 'windows')
    await page.locator('#pairing-server').fill('http://nessie.example.com')
    await page.getByRole('dialog').getByRole('button', { name: 'Get pairing code' }).click()
    await page.getByRole('dialog').getByText('The server address must start with https://.').waitFor()
    assert.equal(await page.locator('#error').isHidden(), true)
    await page.locator('#pairing-server').fill('https://api.nessie.works')
    await page.screenshot({ path: join(output, `${host}-add-team.png`), fullPage: true })
    await page.getByRole('dialog').getByRole('button', { name: 'Get pairing code' }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.deepEqual((await lastCall(page, 'executor_pairing_start')).args, { replace: false, apiBaseUrl: 'https://api.nessie.works',
      ...(host === 'windows' ? { personalPlanConnection: false } : {}) })
    assert.equal(await page.locator('#pairing-code').evaluate((node) => getComputedStyle(node).color), 'rgb(0, 0, 0)')
    await page.getByRole('button', { name: 'Copy pairing code' }).click()
    assert.deepEqual((await lastCall(page, 'executor_copy_code')).args, { code: '01234567' })
    await page.screenshot({ path: join(output, `${host}-code.png`), fullPage: true })
    // Escape cancels the attempt rather than hiding a live code.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_pairing_cancel'))
    await page.waitForFunction(() => !document.getElementById('pair-dialog').open)
    await page.getByRole('button', { name: 'Add team', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Get pairing code' }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    // The computer asks nothing: the only way on is the claim in Nessie.
    assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).count(), 0)
    // A code that runs out offers a new code.
    await page.evaluate(() => { window.expiresAt = new Date(Date.now() - 1000).toISOString() })
    await page.getByRole('button', { name: 'Get new code' }).waitFor()
    assert.equal(await page.locator('#pairing-instruction').textContent(), 'This code has expired.')
    // Checks carry on, so a claim made just before expiry still completes.
    const checks = await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_pairing_status').length)
    await page.waitForFunction((before) => window.calls.filter((call) => call.command === 'executor_pairing_status').length > before, checks)
    await page.evaluate(() => { window.expiresAt = undefined; window.pairStatus = 'waiting' })
    await page.getByRole('button', { name: 'Get new code' }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.evaluate(() => window.claimInNessie())
    await page.waitForSelector('.connection-row')
    assert.equal(await page.locator('#pair-dialog').evaluate((dialog) => dialog.open), false)
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_notify'))
    assert.deepEqual((await lastCall(page, 'executor_notify')).args, { title: 'Connected',
      body: 'Connected to UnlikeOtherAI, Platform. If you didn’t expect this, remove the team in Teams.' })
    assert.equal(await lastCall(page, 'executor_pairing_confirm'), undefined)
    await page.getByRole('button', { name: 'Add team', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Get pairing code' }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    await page.evaluate(() => window.claimInNessie())
    await page.waitForFunction(() => document.querySelectorAll('.connection-row').length === 2)
    // The poll that finds it paired selects the new team, then announces it; wait for both.
    await page.waitForFunction(() => window.calls.filter((call) => call.command === 'executor_notify').length === 2)
    assert.equal(await page.locator('#connection option').count(), 2)
    assert.equal(await page.locator('#running').isChecked(), true)
    assert.equal(await page.getByRole('button', { name: 'Remove UnlikeOtherAI / Research from this computer' }).count(), 1)
    await page.screenshot({ path: join(output, `${host}-teams.png`), fullPage: true })

    await page.getByRole('button', { name: 'ChatGPT · UnlikeOtherAI / Platform', exact: true }).click()
    await page.locator('#chatgpt-status').getByText('Not signed in', { exact: true }).waitFor()
    assert.equal(await page.locator('#chatgpt-start').isDisabled(), true)
    await page.locator('#chatgpt-restriction').check()
    await page.locator('#chatgpt-start').focus()
    await page.keyboard.press('Enter')
    await page.locator('#chatgpt-status').getByText('Ready for your private agents', { exact: true }).waitFor()
    assert.deepEqual((await lastCall(page, 'executor_personal_chatgpt')).args, { executorId: 'team-0',
      operation: { operation: 'start', acknowledgeHostRestriction: true, profileId: 'b83e9273-6e74-4a75-bada-9c3d5b80b493' } })
    await page.locator('#chatgpt-background').click()
    await page.getByRole('button', { name: 'Turn background work off', exact: true }).waitFor()
    const beforeOff = (await lastCall(page, 'executor_personal_chatgpt')).args.operation
    assert.deepEqual(beforeOff, { operation: 'background-consent', profileId: 'b83e9273-6e74-4a75-bada-9c3d5b80b493',
      enabled: true, expectedRevision: null })
    await page.evaluate(() => { window.chatgptOffline = true })
    await page.locator('#chatgpt-refresh').click()
    await page.locator('#chatgpt-status').getByText('Could not update this connection.', { exact: false }).waitFor()
    assert.equal(await page.locator('#chatgpt-background').isVisible(), true)
    assert.equal(await page.locator('#chatgpt-background').textContent(), 'Turn background work off')
    await page.evaluate(() => { window.chatgptOffline = false })
    await page.locator('#chatgpt-background').click()
    await page.getByRole('button', { name: 'Allow background work', exact: true }).waitFor()
    assert.equal((await lastCall(page, 'executor_personal_chatgpt')).args.operation.expectedRevision, 1)
    await page.locator('#chatgpt-usage').click()
    assert.deepEqual((await lastCall(page, 'executor_chatgpt_usage')).args, {})
    await page.screenshot({ path: join(output, `${host}-chatgpt.png`), fullPage: true })
    await page.locator('#chatgpt-close').click()

    // Every setting saves itself; there is no Save button anywhere.
    await page.locator('#connection').selectOption('team-0')
    await page.getByRole('tab', { name: 'Commands' }).click()
    assert.equal(await page.getByRole('button', { name: /^save/i }).count(), 0)
    assert.equal(await page.locator('#existing-coding-sessions').isChecked(), true)
    // A save that fails says so in the window, keeps showing what was asked, and offers Try again.
    await page.evaluate(() => { window.failConfigure = 'Nessie Executor could not write this change.' })
    await page.locator('#existing-coding-sessions').click()
    await page.getByRole('button', { name: 'Try again' }).waitFor()
    assert.equal(await page.locator('.save-problem > span').first().textContent(), 'Existing sessions for UnlikeOtherAI / Platform weren’t saved: '
      + 'Nessie Executor could not write this change. Your previous settings still apply.')
    assert.equal(await page.locator('#existing-coding-sessions').isChecked(), false)
    // An unrelated save that succeeds does not hide the failure.
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.locator('#autostart').check()
    await page.waitForFunction(() => window.enabled)
    assert.match(await status(), /weren’t saved/)
    await page.getByRole('tab', { name: 'Commands' }).click()
    // Try again resends exactly what was attempted, for the team it was attempted for, from any team.
    await page.locator('#connection').selectOption('team-1')
    await page.waitForFunction(() => document.getElementById('command-mode').value === 'all')
    await page.evaluate(() => { window.failConfigure = null })
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.waitForFunction(() => window.existingSessions['team-0'] === false)
    assert.equal(await page.evaluate(() => window.existingSessions['team-1']), undefined)
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Settings saved')
    assert.equal(await page.getByRole('button', { name: 'Try again' }).isHidden(), true)
    await page.locator('#connection').selectOption('team-0')
    await page.waitForFunction(() => document.getElementById('tab-commands').hidden === false)
    assert.equal(await page.locator('#existing-coding-sessions').isChecked(), false)
    // Written, but the answer was lost while the team stayed connected: that is a save.
    await page.evaluate(() => { window.failAfterWrite = 'The answer was lost.' })
    await page.locator('#existing-coding-sessions').click()
    await page.waitForFunction(() => window.existingSessions['team-0'] === true)
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Settings saved')
    assert.equal(await page.getByRole('button', { name: 'Try again' }).isHidden(), true)
    // Written, and the team did not come back: it says exactly that.
    await page.evaluate(() => { window.failAfterWrite = 'The connection did not come back.'; window.dropConnection = true })
    await page.locator('#existing-coding-sessions').click()
    await page.waitForFunction(() => /isn’t connected after saving/.test(document.getElementById('save-status').textContent))
    assert.equal(await page.locator('.save-problem > span').first().textContent(),
      'UnlikeOtherAI / Platform isn’t connected after saving: The connection did not come back.')
    assert.equal(await page.locator('#existing-coding-sessions').isChecked(), false)
    // Try again here reconnects rather than saving again.
    await page.evaluate(() => { window.failAfterWrite = null })
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'UnlikeOtherAI / Platform is connected again.')
    // Only that team is started again.
    assert.deepEqual((await lastCall(page, 'executor_reconnect')).args, { executorId: 'team-0' })
    await page.evaluate(() => { window.dropConnection = false })
    // A newer edit replaces an older failure and its Try again, which can no longer overwrite it.
    await page.evaluate(() => { window.failConfigure = 'The rules could not be written.' })
    await page.locator('#command-denylist').fill('rm *')
    await page.getByRole('button', { name: 'Try again' }).waitFor()
    await page.evaluate(() => { window.failConfigure = null })
    await page.locator('#command-denylist').fill('')
    assert.equal(await page.getByRole('button', { name: 'Try again' }).isHidden(), true)
    await page.waitForFunction(() => window.policies['team-0'].denylist.length === 0 && document.getElementById('save-status').textContent === 'Settings saved')
    // Only listed commands waits for its first command instead of saving an empty list.
    const saves = await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_configure').length)
    await page.locator('#command-mode').selectOption('allowlist')
    await page.getByText('Add at least one allowed command.', { exact: true }).waitFor()
    assert.equal(await status(), 'Command changes not saved. Add at least one allowed command.')
    assert.equal(await page.evaluate(() => window.calls.filter((call) => call.command === 'executor_configure').length), saves)
    await page.locator('#command-allowlist').fill('git *')
    await page.locator('#command-denylist').fill('git push *')
    await page.waitForFunction(() => window.policies['team-0'].denylist[0] === 'git push *')
    assert.deepEqual(await page.evaluate(() => window.policies['team-0']), { mode: 'allowlist', allowlist: ['git *'], denylist: ['git push *'] })
    await page.waitForFunction(() => window.calls.at(-1)?.command === 'executor_notify')
    assert.deepEqual((await lastCall(page, 'executor_notify')).args, { title: 'Settings saved', body: 'Commands for UnlikeOtherAI / Platform' })
    assert.deepEqual(await page.evaluate(() => window.policies['team-1']), { mode: 'all', allowlist: [], denylist: [] })
    assert.equal(await page.locator('#terminal-form, #terminal-command').count(), 0)
    assert.match(await page.locator('#tab-commands').textContent(), /interactive terminal on this computer/)
    await page.locator('#connection').selectOption('team-1')
    await page.waitForFunction(() => document.getElementById('command-mode').value === 'all')
    assert.equal(await page.locator('#existing-coding-sessions').isChecked(), true)
    await page.screenshot({ path: join(output, `${host}-commands.png`), fullPage: true })
    await page.getByRole('button', { name: 'Set up Claude Code to receive messages…' }).click()
    assert.match(await page.locator('#claude-channel-config').textContent(), /serve-existing-claude-channel/)
    assert.match(await page.locator('#claude-dialog').textContent(), /dangerously-load-development-channels/)
    await page.screenshot({ path: join(output, `${host}-claude-setup.png`), fullPage: true })
    await page.locator('#claude-dialog').getByRole('button', { name: 'Close' }).click()

    // New teams reach the home Nessie folder and the shared folder; adding one saves at once.
    await page.getByRole('tab', { name: 'Folders' }).click()
    assert.match(await page.locator('#reach-folders').textContent(), /Nessie\/Users\/person\/Nessie.*Shared\/Users\/Shared/)
    await page.getByRole('button', { name: 'Add folder…' }).click()
    await page.waitForFunction(() => window.folders['team-1'].some((folder) => folder.name === 'notes'))
    await page.screenshot({ path: join(output, `${host}-folders.png`), fullPage: true })
    // Two removals in a row both stick: each save sends the whole draft.
    await page.getByRole('button', { name: 'Stop sharing Nessie with UnlikeOtherAI / Research' }).click()
    await page.getByRole('button', { name: 'Stop sharing Notes with UnlikeOtherAI / Research' }).click()
    await page.waitForFunction(() => window.folders['team-1'].length === 1 && window.folders['team-1'][0].name === 'shared')
    assert.equal(await page.getByRole('button', { name: 'Stop sharing Shared with UnlikeOtherAI / Research' }).isDisabled(), true)
    await page.getByText('Keep at least one folder.').waitFor()
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.locator('#autostart').check()
    await page.waitForFunction(() => window.enabled)
    // Restarting a stopped connection sits below the login switch, on until turned off.
    const settings = await page.locator('#tab-settings input[type=checkbox]').evaluateAll((inputs) => inputs.map((input) => input.id))
    assert.deepEqual(settings, ['autostart', 'auto-restart', 'update-automatic'])
    assert.equal(await page.getByLabel('Restart a connection if it stops').isChecked(), true)
    await page.screenshot({ path: join(output, `${host}-settings.png`), fullPage: true })
    await page.getByLabel('Restart a connection if it stops').uncheck()
    await page.waitForFunction(() => window.autoRestart === false)
    await page.waitForFunction(() => window.calls.at(-1)?.command === 'executor_notify')
    assert.deepEqual((await lastCall(page, 'executor_notify')).args,
      { title: 'Settings saved', body: 'Stopped connections stay stopped until you start them' })
    assert.equal(await page.getByLabel('Restart a connection if it stops').isChecked(), false)
    await page.getByLabel('Restart a connection if it stops').check()
    await page.waitForFunction(() => window.autoRestart === true)

    // One switch turns every team off; removing a team signs it off.
    await page.locator('#running-switch').click()
    await page.waitForFunction(() => !document.getElementById('running').checked && !document.getElementById('running').disabled)
    assert.deepEqual((await lastCall(page, 'executor_set_running')).args, { running: false })
    assert.equal(await page.locator('#running-label').textContent(), 'All team connections')
    assert.equal(await status(), 'Team connections are off until Nessie Executor next opens.')
    await page.locator('#running-switch').click()
    await page.waitForFunction(() => document.getElementById('running').checked && !document.getElementById('running').disabled)
    assert.notEqual(await status(), 'Team connections are off until Nessie Executor next opens.')
    await page.evaluate(() => { window.paired[1].daemonStatus = 'running elsewhere' })
    await page.getByText('1 running in another app').waitFor()
    await page.evaluate(() => { window.paired[1].daemonStatus = 'running' })
    // A problem for a team goes with the team when it is removed.
    await page.evaluate(() => { window.failConfigure = 'The rules could not be written.' })
    await page.locator('#connection').selectOption('team-0')
    await page.getByRole('tab', { name: 'Commands' }).click()
    await page.locator('#existing-coding-sessions').click()
    await page.getByRole('button', { name: 'Try again' }).waitFor()
    await page.evaluate(() => { window.failConfigure = null })
    await page.waitForFunction(() => window.calls.at(-1)?.command === 'executor_notify' || window.calls.some((call) =>
      call.command === 'executor_notify' && call.args.title === 'Team connections off'))
    await page.getByRole('tab', { name: 'Teams' }).click()
    await page.getByRole('button', { name: 'Remove UnlikeOtherAI / Platform from this computer' }).click()
    assert.equal(await page.evaluate(() => document.activeElement.id), 'remove-cancel')
    assert.match(await page.locator('#remove-summary').textContent(), /UnlikeOtherAI \/ Platform/)
    await page.screenshot({ path: join(output, `${host}-remove.png`), fullPage: true })
    await page.getByRole('button', { name: 'Remove team' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.connection-row').length === 1)
    assert.equal(await page.getByRole('button', { name: 'Try again' }).isHidden(), true)
    assert.doesNotMatch(await status(), /weren’t saved/)
    assert.deepEqual((await lastCall(page, 'executor_remove')).args, { executorId: 'team-0' })
    await page.waitForFunction(() => window.calls.at(-1)?.command === 'executor_notify')
    assert.equal((await lastCall(page, 'executor_notify')).args.title, 'Team removed')
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write(`Shared Windows/macOS console passed. Screenshots: ${output}\n`)
} finally { await browser.close() }
