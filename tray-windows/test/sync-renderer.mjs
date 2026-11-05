// The Sync tab in every locale and state, at phone and desktop widths, and its
// actions on both hosts. Only native IPC is replaced: the page under test is
// the shipped console.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'
import { installSyncHost, syncCases, syncIds, syncState, syncTrash } from './sync-fixtures.mjs'

const LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']
const REFUSALS = ['root_not_absolute', 'root_missing', 'root_not_a_directory', 'root_is_link', 'root_not_writable',
  'root_overlaps_workspace_folder', 'root_inside_state_directory', 'root_inside_other_sync', 'not_private',
  'conflict_not_found', 'held_deletes_changed']
const FOLDER_REFUSALS = REFUSALS.slice(0, 9)

// Tall enough that a screenshot shows the whole tab, which scrolls inside the window.
const openConsole = async (browser, ui, files, { host, locale, width, fixture }) => {
  const context = await browser.newContext({ locale, viewport: { width, height: 2400 } })
  await installRendererHost(context, host, { paired: true })
  await installSyncHost(context, fixture, syncTrash)
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
  await page.getByRole('tab', { name: 'Sync' }).click()
  await page.locator('#tab-sync').waitFor()
  return { context, page, errors }
}

const words = (page, path) => page.evaluate((key) => key.split('.').reduce((node, part) => node?.[part],
  window.syncConsoleWords.words), path)
const expectedStatus = (page, key, count) => page.evaluate(([name, n]) => (name === 'syncing'
  ? window.syncConsoleWords.count('syncing', n) : window.syncConsoleWords.words.state[name]), [key, count])
const lastCall = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).at(-1), command)
const calls = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).map((call) => call.args), command)
const statusIs = (page, text) => page.waitForFunction((expected) => document.getElementById('sync-state-text').textContent === expected, text)
/** Shows a state: the fixture changes and pressing the open tab again reads it. */
const show = async (page, state) => {
  await page.evaluate((next) => { window.syncFixture = next }, state)
  await page.getByRole('tab', { name: 'Sync' }).click()
}

/** Nothing in the tab, the tab strip or an open dialog runs past its box or the window. */
const assertFits = async (page, label) => {
  const problems = await page.evaluate(() => {
    const found = []
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth) found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`)
    const scopes = [document.getElementById('tab-sync'), document.querySelector('.tabs'), ...document.querySelectorAll('dialog[open]')]
    for (const scope of scopes) {
      const edge = scope.getBoundingClientRect().right + 0.5
      for (const node of [scope, ...scope.querySelectorAll('*')]) {
        if (node.closest('[hidden]') || !node.getClientRects().length) continue
        const box = node.getBoundingClientRect()
        const name = node.id || node.className || node.tagName
        if (box.right > edge) found.push(`${name} runs past its container by ${Math.round(box.right - edge)}px`)
        if (['BUTTON', 'P', 'H2', 'H3', 'LI', 'SPAN', 'SMALL'].includes(node.tagName) && node.scrollWidth > node.clientWidth + 1
          && node.clientWidth > 0) found.push(`${name} clips its text`)
      }
    }
    return found
  })
  assert.deepEqual(problems, [], label)
}

export const verifySyncTab = async (browser, ui, files, root) => {
  const output = join(root, '.artifacts/folder-sync-console')
  await mkdir(output, { recursive: true })
  let shots = 0

  // Every state in every locale at phone and desktop width: the honest line, its detail, and nothing clipped.
  for (const locale of LOCALES) {
    for (const width of [390, 1280]) {
      const cases = syncCases('windows')
      const { context, page, errors } = await openConsole(browser, ui, files, { host: 'windows', locale, width, fixture: cases[0].state })
      const lang = await page.evaluate(() => window.syncConsoleWords.locale)
      assert.equal(lang.split('-')[0], locale.split('-')[0], `${locale} has its own Sync words`)
      for (const { name, state, key, count } of cases) {
        await show(page, state)
        await statusIs(page, await expectedStatus(page, key, count))
        assert.equal(await page.locator('#sync-enabled').isDisabled(), key === 'not_private', `${name} switch`)
        assert.equal(await page.locator('#sync-enabled').isChecked(), state.enabled, `${name} switch position`)
        assert.equal(await page.locator('#sync-body').isHidden(), key === 'not_private', `${name} body`)
        if (key !== 'not_private') {
          assert.equal(await page.locator('#sync-open-nessie').isVisible(),
            ['waiting_for_confirmation', 'needs_reauthorization'].includes(key), `${name} Open Nessie`)
          assert.equal(await page.locator('#sync-conflict-list .sync-conflict').count(), state.conflicts.length)
          assert.equal(await page.locator('#sync-held').isVisible(), state.heldDeletes !== null)
        }
        if (key === 'syncing' || key === 'up_to_date') {
          // The engine's own word never wins over the counts.
          assert.equal(key === 'up_to_date', state.counts.pendingUploads + state.counts.pendingDownloads === 0 && !state.conflicts.length)
        }
        assert.equal(await page.getByRole('button', { name: /^save$/i }).count(), 0)
        await assertFits(page, `${locale} ${width} ${name}`)
        await page.screenshot({ path: join(output, `sync-${name}-${locale}-${width}.png`), fullPage: true, animations: 'disabled' })
        shots += 1
      }
      // Each refusal reads in this locale, the folder's under the folder and the rest under the tabs.
      if (width === 390) {
        await show(page, syncState('windows'))
        await statusIs(page, await expectedStatus(page, 'up_to_date'))
        for (const reason of FOLDER_REFUSALS) {
          await page.evaluate((refusal) => { window.syncPicked = 'C:\\Users\\person\\Nessie'; window.syncRefuse = refusal }, reason)
          await page.locator('#sync-choose').click()
          const sentence = await words(page, `refusals.${reason}`)
          await page.waitForFunction((text) => document.getElementById('sync-refusal').textContent === text, sentence)
          assert.ok(sentence && sentence !== await words(page, 'refusals.other'), `${locale} ${reason}`)
          await assertFits(page, `${locale} refusal ${reason}`)
        }
        await page.screenshot({ path: join(output, `sync-refusal-${locale}-390.png`), fullPage: true, animations: 'disabled' })
        await show(page, cases.find((entry) => entry.name === 'needs-attention').state)
        await page.locator('#sync-conflict-list .sync-conflict').first().waitFor()
        for (const reason of REFUSALS.slice(FOLDER_REFUSALS.length)) {
          await page.evaluate((refusal) => { window.syncRefuse = refusal }, reason)
          await page.locator(reason === 'conflict_not_found' ? '#sync-conflict-list button >> nth=0' : '#sync-held-restore').click()
          await page.waitForFunction((text) => document.getElementById('error').textContent === text, await words(page, `refusals.${reason}`))
        }
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
  }

  const hosts = ['windows', 'macos'].flatMap((host) => [390, 1280].map((width) => ({ host, width })))
  for (const { host, width } of hosts) {
    const fixture = syncCases(host)[0].state
    const { context, page, errors } = await openConsole(browser, ui, files, { host, locale: 'en-GB', width, fixture })
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await statusIs(page, 'Off')
    assert.match(await page.locator('#sync-folder').textContent(), /Documents.Nessie \(suggested\)$/)
    // Turning sync on in a folder that already has files asks first, then asks Nessie.
    await page.evaluate(() => { window.syncExistingFiles = 14 })
    await page.locator('#sync-switch').click()
    await page.locator('#sync-existing-dialog').waitFor()
    assert.equal(await page.locator('#sync-existing-body').textContent(),
      'This folder already has 14 files. They will be added to Nessie for UnlikeOtherAI / Platform.')
    assert.equal(await page.locator('#sync-enabled').isChecked(), false, 'nothing turned on before the person agrees')
    await assertFits(page, `${host} existing files dialog`)
    await page.screenshot({ path: join(output, `${host}-sync-existing-files-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.evaluate(() => { window.syncExistingFiles = 0 })
    await page.getByRole('button', { name: 'Add and sync' }).click()
    await statusIs(page, 'Waiting for you to allow it in Nessie')
    assert.equal(await page.locator('#sync-pause').isHidden(), true, 'nothing to pause before Nessie allows it')
    assert.deepEqual(await calls(page, 'executor_sync_configure'), [
      { executorId: 'team-0', command: { command: 'configure', root: fixture.defaultRoot, enabled: true, acceptExistingFiles: false } },
      { executorId: 'team-0', command: { command: 'configure', root: fixture.defaultRoot, enabled: true, acceptExistingFiles: true } },
    ])
    assert.equal(await page.locator('#sync-enabled').isChecked(), true)
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Settings saved')
    assert.deepEqual((await lastCall(page, 'executor_notify')).args, { title: 'Settings saved', body: 'Sync is on for UnlikeOtherAI / Platform' })
    // The request is answered in Nessie, at the address the handshake gave.
    await page.locator('#sync-open-nessie').click()
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_sync_open_nessie'))
    assert.deepEqual((await lastCall(page, 'executor_sync_open_nessie')), { command: 'executor_sync_open_nessie', args: { executorId: 'team-0' } })
    await page.screenshot({ path: join(output, `${host}-sync-allow-in-nessie-${width}.png`), fullPage: true, animations: 'disabled' })

    // A folder choice and the switch wait in one queue; the switch carries the folder as it is when its turn comes.
    await show(page, syncState(host))
    await statusIs(page, 'Up to date')
    await page.evaluate(() => { window.syncPicked = '/Users/person/Sync'; window.syncConfigureDelay = 300 })
    const before = (await calls(page, 'executor_sync_configure')).length
    await page.locator('#sync-choose').click()
    await page.waitForFunction((count) => window.calls.filter((call) => call.command === 'executor_sync_configure').length > count, before)
    await page.locator('#sync-switch').click()
    assert.equal(await page.locator('#sync-enabled').isDisabled(), true, 'the switch waits visibly')
    await statusIs(page, 'Off')
    assert.deepEqual((await calls(page, 'executor_sync_configure')).slice(before).map((args) => args.command), [
      { command: 'configure', root: '/Users/person/Sync', enabled: true, acceptExistingFiles: false },
      { command: 'configure', root: '/Users/person/Sync', enabled: false, acceptExistingFiles: false },
    ])
    await page.evaluate(() => { window.syncConfigureDelay = 0 })

    // Pause and resume.
    await show(page, syncState(host))
    await statusIs(page, 'Up to date')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await statusIs(page, 'Paused')
    assert.deepEqual((await lastCall(page, 'executor_sync_configure')).args.command, { command: 'pause', paused: true })
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await statusIs(page, 'Up to date')
    await page.getByRole('button', { name: 'Open folder', exact: true }).click()
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_open_path'))
    assert.deepEqual((await lastCall(page, 'executor_open_path')).args, { executorId: 'team-0', location: 'root' })

    // Conflicts: each row's actions name the row, and a resolution closes it.
    const attention = syncCases(host).find((entry) => entry.name === 'needs-attention').state
    await show(page, attention)
    await statusIs(page, 'Needs your attention')
    const first = attention.conflicts[0]
    assert.equal(await page.locator('#sync-conflict-list .sync-conflict').count(), 4)
    assert.match(await page.locator('#sync-conflicts').textContent(), /Changed here and in Nessie\. Both versions are kept\./)
    assert.deepEqual(await page.locator('.sync-conflict').nth(0).getByRole('button').allTextContents(), ['Use my version', 'Use Nessie’s version', 'Show in folder'])
    assert.deepEqual(await page.locator('.sync-conflict').nth(1).getByRole('button').allTextContents(), ['Use Nessie’s version', 'Keep both', 'Show in folder'])
    assert.deepEqual(await page.locator('.sync-conflict').nth(2).getByRole('button').allTextContents(), ['Show in folder', 'Dismiss'])
    await page.screenshot({ path: join(output, `${host}-sync-conflicts-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.locator('.sync-conflict').nth(0).getByRole('button', { name: 'Show in folder' }).click()
    await page.waitForFunction((relPath) => window.calls.some((call) => call.command === 'executor_open_path' && call.args.relPath === relPath), first.relPath)
    assert.deepEqual((await lastCall(page, 'executor_open_path')).args, { executorId: 'team-0', location: 'file', relPath: first.relPath })
    await page.locator('.sync-conflict').nth(0).getByRole('button', { name: 'Use my version' }).click()
    await page.waitForFunction(() => document.querySelectorAll('#sync-conflict-list .sync-conflict').length === 3)
    assert.deepEqual((await lastCall(page, 'executor_sync_resolve')).args,
      { executorId: 'team-0', clientConflictId: syncIds.copy, resolution: 'keep_mine' })
    await page.locator('.sync-conflict').nth(0).getByRole('button', { name: 'Keep both' }).click()
    await page.waitForFunction(() => document.querySelectorAll('#sync-conflict-list .sync-conflict').length === 2)
    assert.deepEqual((await lastCall(page, 'executor_sync_resolve')).args,
      { executorId: 'team-0', clientConflictId: syncIds.quarantine, resolution: 'dismiss' })

    // Held deletions: the person decides, naming the held set they saw.
    assert.match(await page.locator('#sync-held').textContent(), /23 files were deleted from this folder at once\./)
    assert.match(await page.locator('#sync-held').textContent(), /and 20 more/)
    await page.getByRole('button', { name: 'Restore files' }).click()
    await page.locator('#sync-held').waitFor({ state: 'hidden' })
    assert.deepEqual((await lastCall(page, 'executor_sync_configure')).args.command,
      { command: 'held_deletes', batchId: syncIds.batch, decision: 'restore' })
    await show(page, attention)
    await page.getByRole('button', { name: 'Delete in Nessie too' }).click()
    await page.locator('#sync-held').waitFor({ state: 'hidden' })
    assert.equal((await lastCall(page, 'executor_sync_configure')).args.command.decision, 'confirm')

    // Deleted files: the local trash, restorable one file at a time.
    await page.getByRole('button', { name: 'Deleted files…' }).click()
    await page.getByRole('button', { name: 'Restore · Product/Old plan.md' }).waitFor()
    await assertFits(page, `${host} deleted files`)
    await page.screenshot({ path: join(output, `${host}-sync-deleted-files-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Restore · Product/Old plan.md' }).click()
    await page.waitForFunction(() => document.querySelectorAll('#sync-deleted-list .folder-row').length === 1)
    assert.deepEqual((await lastCall(page, 'executor_sync_trash_restore')).args,
      { executorId: 'team-0', entryId: '2026-11-02/Product/Old plan.md' })
    assert.equal(await page.locator('#save-status').textContent(), 'Restored Product/Old plan.md')
    await page.locator('#sync-deleted-open').click()
    await page.waitForFunction(() => window.calls.at(-1)?.command === 'executor_open_path')
    assert.deepEqual((await lastCall(page, 'executor_open_path')).args, { executorId: 'team-0', location: 'trash' })
    await page.locator('#sync-deleted-close').click()

    // A status that cannot be read says so and offers Try again.
    await page.evaluate(() => { window.syncStatusFails = 'The local executor request timed out.' })
    await page.getByRole('tab', { name: 'Sync' }).click()
    await page.getByText('Couldn’t check sync on this computer. The local executor request timed out.').waitFor()
    await page.evaluate(() => { window.syncStatusFails = null })
    await page.locator('#sync-reload').click()
    await page.locator('#sync-load-error').waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
    await context.close()
  }
  await verifyTrayDoorway(browser, ui, files)
  process.stdout.write(`Sync tab: ${shots} state screenshots in 7 locales at 390 and 1280 px, actions/dialogs at both widths and the tray's Sync line on both hosts. Screenshots: ${output}\n`)
}

/**
 * The tray's and menu bar's Sync line opens this tab on the team its status is
 * about — also when the window is still loading its team list, as a window the
 * menu bar has just created is.
 */
const verifyTrayDoorway = async (browser, ui, files) => {
  for (const host of ['windows', 'macos']) {
    const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 640, height: 900 } })
    await installRendererHost(context, host, { paired: true })
    await context.addInitScript(() => {
      window.claimInNessie()
      window.addEventListener('load', () => window.emitTray('tray://section/sync', { executorId: 'team-1' }))
    })
    await installSyncHost(context, syncState(host, { executorId: 'team-1' }), syncTrash)
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
    const selected = () => page.getByRole('tab', { name: 'Sync' }).getAttribute('aria-selected')
    await statusIs(page, 'Up to date')
    await page.waitForFunction(() => document.querySelectorAll('#connection option').length >= 2)
    assert.equal(await page.locator('#connection').inputValue(), 'team-1', `${host} opens the named team`)
    assert.equal(await selected(), 'true')
    // The other team's sync was never read, so its status was never on screen.
    assert.deepEqual([...new Set((await calls(page, 'executor_sync_status')).map((args) => args.executorId))], ['team-1'])

    // A team this computer does not list is ignored, and the tab still opens; so does a line naming no team.
    for (const target of [{ executorId: 'team-9' }, null, {}]) {
      await page.getByRole('tab', { name: 'Teams' }).click()
      await page.evaluate((payload) => window.emitTray('tray://section/sync', payload), target)
      await page.waitForFunction(() => document.getElementById('tab-button-sync').getAttribute('aria-selected') === 'true')
      assert.equal(await page.locator('#connection').inputValue(), 'team-1', `${host} ${JSON.stringify(target)}`)
    }
    // The line can also move the window to another team's Sync tab.
    await page.evaluate(() => window.emitTray('tray://section/sync', { executorId: 'team-0' }))
    await page.waitForFunction(() => document.getElementById('connection').value === 'team-0')
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_sync_status' && call.args.executorId === 'team-0'))
    assert.deepEqual(errors, [])
    await context.close()
  }
}
