// The Documents tab in every state, with the one Allow in Nessie step, pause,
// conflicts, held deletions and Deleted files, on both hosts and in every locale.
import assert from 'node:assert/strict'
import { syncCases, syncIds, syncState } from './sync-fixtures.mjs'
import { LOCALES, assertFits, callArgs, callCount, lastCall, openConsole, screenshot, selectTeam, showTab } from './renderer-page.mjs'

/** The tab shows the chosen team's switch; the tab and the dropdown name the team, so there is no heading. */
const documentsFor = (page, team) => page.waitForFunction((expected) => document.getElementById('documents-switch-label')?.textContent === expected,
  `Keep a copy of ${team}’s documents on this computer`)
const statusIs = (page, text) => page.waitForFunction((expected) => document.getElementById('documents-state-text').textContent === expected, text)
const expected = (page, key, count) => page.evaluate(([name, n]) => (name === 'syncing'
  ? window.documentsWords.count('syncing', n) : window.nc.t(`documents.state.${name}`)), [key, count])
/** Shows a state: the fixture changes and pressing the open tab again reads it. */
const show = async (page, state) => {
  await page.evaluate((next) => { window.syncFixture = next }, state)
  await showTab(page, 'documents')
}
const open = async (browser, ui, options) => {
  const opened = await openConsole(browser, ui, { paired: 2, ...options })
  await showTab(opened.page, 'documents')
  await opened.page.locator('#tab-documents').waitFor()
  return opened
}

export const verifyDocumentsTab = async (browser, ui, output) => {
  let shots = 0
  for (const locale of LOCALES) {
    for (const size of ['minimum', 'desktop']) {
      const cases = syncCases('windows')
      const { context, page, errors } = await open(browser, ui, { host: 'windows', locale, size, sync: cases[0].state })
      assert.equal(await page.evaluate(() => document.documentElement.lang.split('-')[0]), locale.split('-')[0])
      for (const { name, state, key, count } of cases) {
        await show(page, state)
        await statusIs(page, await expected(page, key, count))
        assert.equal(await page.locator('#documents-enabled').isDisabled(), key === 'not_private', `${name} switch`)
        assert.equal(await page.locator('#documents-enabled').isChecked(), state.enabled, `${name} switch position`)
        assert.equal(await page.locator('#documents-body').isHidden(), key === 'not_private', `${name} body`)
        if (key !== 'not_private') {
          assert.equal(await page.locator('#documents-open-nessie').isVisible(), ['waiting_for_confirmation', 'needs_reauthorization'].includes(key), `${name} Allow in Nessie`)
          assert.equal(await page.locator('#documents-conflict-list .documents-conflict').count(), state.conflicts.length)
          assert.equal(await page.locator('#documents-held').isVisible(), state.heldDeletes !== null)
        }
        await assertFits(page, `${locale} ${size} ${name}`)
        if (locale === 'cs' || locale === 'en-GB') {
          await screenshot(page, output, `documents-${name}-${locale}-${size}`)
          shots += 1
        }
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
  }

  for (const host of ['windows', 'macos']) {
    const fixture = syncCases(host)[0].state
    const { context, page, errors } = await open(browser, ui, { host, sync: fixture })
    const shot = (name) => screenshot(page, output, `${host}-documents-${name}`)
    await documentsFor(page, 'Platform · UnlikeOtherAI')
    assert.equal(await page.locator('#team-row').isVisible(), true, 'the team row shows on Documents')
    assert.equal(await page.locator('#documents-switch-label').textContent(), 'Keep a copy of Platform · UnlikeOtherAI’s documents on this computer')
    await statusIs(page, 'Off')
    assert.match(await page.locator('#documents-folder').textContent(), /Documents.Nessie \(suggested\)$/)
    // Turning it on in a folder that already has files asks first, then waits for Nessie's one Allow step.
    await page.evaluate(() => { window.syncExistingFiles = 14 })
    await page.locator('#documents-switch').click()
    await page.locator('#documents-existing-dialog').waitFor()
    assert.equal(await page.locator('#documents-existing-body').textContent(), 'This folder already has 14 files. They will be added to Nessie for Platform · UnlikeOtherAI.')
    assert.equal(await page.locator('#documents-enabled').isChecked(), false, 'nothing turned on before the person agrees')
    await shot('existing-files')
    await page.evaluate(() => { window.syncExistingFiles = 0 })
    await page.getByRole('button', { name: 'Add and sync' }).click()
    await statusIs(page, 'Waiting for you to allow it in Nessie')
    assert.equal(await page.locator('#documents-pause').isHidden(), true, 'nothing to pause before Nessie allows it')
    assert.deepEqual(await callArgs(page, 'executor_sync_configure'), [
      { executorId: 'team-0', command: { command: 'configure', root: fixture.defaultRoot, enabled: true, acceptExistingFiles: false } },
      { executorId: 'team-0', command: { command: 'configure', root: fixture.defaultRoot, enabled: true, acceptExistingFiles: true } },
    ])
    await page.waitForFunction(() => document.getElementById('documents-saved').textContent === 'Sync is on for Platform · UnlikeOtherAI')
    assert.equal(await page.evaluate(() => window.restarts), 0, 'a save never restarts a team or posts a notification')
    await shot('allow-in-nessie')
    await page.getByRole('button', { name: 'Allow in Nessie' }).click()
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_sync_open_nessie'))

    // Pause and resume, Open folder.
    await show(page, syncState(host))
    await statusIs(page, 'Up to date')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await statusIs(page, 'Paused')
    assert.deepEqual((await lastCall(page, 'executor_sync_configure')).args.command, { command: 'pause', paused: true })
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await statusIs(page, 'Up to date')
    await page.getByRole('button', { name: 'Open folder', exact: true }).click()
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_open_path'))

    // A folder refusal shows under the folder; another refusal shows beside the control that asked.
    await page.evaluate(() => { window.syncPicked = '/Users/person/Nessie'; window.syncRefuse = 'root_overlaps_workspace_folder' })
    await page.locator('#documents-choose').click()
    await page.getByText('That folder is inside, or contains, a folder this team’s agents can read', { exact: false }).waitFor()
    await shot('refusal')

    // Files to check and deletions on hold.
    const attention = syncCases(host).find((entry) => entry.name === 'needs-attention').state
    await show(page, attention)
    await statusIs(page, 'Needs your attention')
    assert.equal(await page.locator('#documents-conflict-list .documents-conflict').count(), 4)
    await page.locator('.documents-conflict').nth(0).getByRole('button', { name: 'Use my version' }).click()
    await page.waitForFunction(() => document.querySelectorAll('#documents-conflict-list .documents-conflict').length === 3)
    assert.deepEqual((await lastCall(page, 'executor_sync_resolve')).args, { executorId: 'team-0', clientConflictId: syncIds.copy, resolution: 'keep_mine' })
    assert.match(await page.locator('#documents-held').textContent(), /23 files were deleted from this folder at once\./)
    await page.evaluate(() => { window.syncRefuse = 'held_deletes_changed' })
    await page.getByRole('button', { name: 'Restore files' }).click()
    await page.locator('[data-error-for=documents-held]').waitFor()
    assert.equal(await page.locator('[data-error-for=documents-held]').textContent(), 'The deletions on hold changed. Check the list again.')
    await page.locator('#documents-held').scrollIntoViewIfNeeded()
    await shot('attention')
    await page.getByRole('button', { name: 'Restore files' }).click()
    await page.locator('#documents-held').waitFor({ state: 'hidden' })

    // Deleted files: the local trash, restorable one file at a time.
    await page.getByRole('button', { name: 'Deleted files…' }).click()
    await page.getByRole('button', { name: 'Restore · Product/Old plan.md' }).waitFor()
    await shot('deleted')
    await page.getByRole('button', { name: 'Restore · Product/Old plan.md' }).click()
    await page.waitForFunction(() => document.querySelectorAll('#documents-deleted-list .list-row').length === 1)
    assert.deepEqual((await lastCall(page, 'executor_sync_trash_restore')).args, { executorId: 'team-0', entryId: '2026-11-02/Product/Old plan.md' })
    await page.locator('#documents-deleted-close').click()

    // A status that cannot be read says so and offers Try again; another team reads its own status.
    await page.evaluate(() => { window.syncStatusFails = 'The local request timed out.' })
    await showTab(page, 'documents')
    await page.getByText('Couldn’t check sync on this computer. The local request timed out.').waitFor()
    await shot('failed')
    await page.evaluate(() => { window.syncStatusFails = null })
    await page.locator('#documents-reload').click()
    await page.locator('#documents-load-error').waitFor({ state: 'hidden' })
    await selectTeam(page, 'team-1')
    await documentsFor(page, 'Research · UnlikeOtherAI')
    await page.waitForFunction(() => window.calls.some((call) => call.command === 'executor_sync_status' && call.args.executorId === 'team-1'))
    assert.equal(await callCount(page, 'executor_apply_remedy'), 0, 'Documents never applies a team remedy')
    await assertFits(page, `${host} documents`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  for (const size of ['desktop', 'minimum']) {
    const { context, page, errors } = await open(browser, ui, { host: 'macos', locale: 'cs', dark: true, size,
      sync: syncCases('macos').find((entry) => entry.name === 'needs-attention').state })
    await statusIs(page, await expected(page, 'needs_attention'))
    await assertFits(page, `cs dark ${size} documents`)
    await screenshot(page, output, `documents-attention-cs-dark-${size}`)
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write(`Documents tab: ${shots} state pictures, actions and failures on both hosts, seven locales in both window sizes.\n`)
}
