// Several teams in one main folder (Documents): each team's tab says where its
// files go — `<main folder>/<Organisation>/<Team>` — every team is offered the
// main folder another team already uses, and each team's switch is its own.
// Two teams on one computer, one switched off; an older one-segment folder;
// both hosts, seven locales, light and dark. Local only, never CI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { installRendererHost } from './renderer-host.mjs'
import { LOCALES, SIZES, assertFits, callArgs, openConsole, screenshot, selectTeam, showTab } from './renderer-page.mjs'
import { syncState } from './sync-fixtures.mjs'

const mainFolder = (host) => (host === 'windows' ? 'C:\\Users\\person\\Documents\\Nessie' : '/Users/person/Documents/Nessie')
const shown = (host, ...segments) => ['Nessie', ...segments].join(host === 'windows' ? '\\' : '/')

/** Platform syncs into the main folder; Research, switched off, is offered the same one. */
export const teamsFixtures = (host) => ({
  'team-0': syncState(host, { executorId: 'team-0', teamLabel: 'UnlikeOtherAI/Platform', teamFolder: 'UnlikeOtherAI/Platform' }),
  'team-1': syncState(host, { executorId: 'team-1', enabled: false, state: 'off', root: null, serverStatus: null, manageUrl: null,
    teamLabel: null, teamFolder: 'UnlikeOtherAI/Research', counts: { ...syncState(host).counts, entries: 0 } }),
})

/** Answers each team from its own state, as each team's `sync status` would. */
const installTeamsSyncHost = (context, fixtures) => context.addInitScript((teams) => {
  window.teamSync = teams
  const clone = (id) => JSON.parse(JSON.stringify(window.teamSync[id]))
  window.syncHost = async (command, args) => {
    const state = window.teamSync[args.executorId]
    if (command === 'executor_sync_status') return clone(args.executorId)
    if (['executor_open_path', 'executor_sync_open_nessie'].includes(command)) return null
    if (command === 'executor_sync_configure' && args.command.command === 'configure') {
      const { root, enabled } = args.command
      Object.assign(state, { root, enabled, state: enabled ? 'waiting_for_confirmation' : 'off',
        serverStatus: enabled ? 'requested' : null })
      return { outcome: 'applied', state: clone(args.executorId) }
    }
    throw new Error(`Unexpected sync command ${command}`)
  }
}, fixtures)

const open = async (browser, ui, { host, locale = 'en-GB', dark = false, size = 'desktop', fixtures = teamsFixtures(host) }) => {
  const context = await browser.newContext({ viewport: SIZES[size], locale, colorScheme: dark ? 'dark' : 'light' })
  await installTeamsSyncHost(context, fixtures)
  const opened = await openConsole(browser, ui, { host, locale, dark, size, paired: 2, sync: null, context })
  await showTab(opened.page, 'documents')
  await opened.page.locator('#tab-documents').waitFor()
  return opened
}

/** The tab shows the chosen team's switch; the tab and the dropdown name the team, so there is no heading. */
const documentsFor = (page, team) => page.waitForFunction((expected) => document.getElementById('documents-switch-label')?.textContent === expected,
  `Keep a copy of ${team}’s documents on this computer`)
const destinationIs = (page, text) => page.waitForFunction((expected) => {
  const line = document.getElementById('documents-destination')
  return !line.hidden && line.textContent === expected
}, text)
const sentence = (page, key, team, path) => page.evaluate(([name, values]) => window.documentsWords.text(name, values),
  [`destination.${key}`, { team, path }])

export const verifyDocumentsTeams = async (browser, ui, output) => {
  for (const host of ['windows', 'macos']) {
    const { context, page, errors } = await open(browser, ui, { host })
    const shot = (name) => screenshot(page, output, `${host}-documents-teams-${name}`)
    await documentsFor(page, 'Platform · UnlikeOtherAI')
    await destinationIs(page, `Platform · UnlikeOtherAI’s documents go in ${shown(host, 'UnlikeOtherAI', 'Platform')}`)
    assert.equal(await page.locator('#documents-folder').textContent(), mainFolder(host))
    await shot('platform-on')

    // The second team is offered the same main folder and told where its own folder will be.
    await selectTeam(page, 'team-1')
    await documentsFor(page, 'Research · UnlikeOtherAI')
    await destinationIs(page, `Research · UnlikeOtherAI’s documents will go in ${shown(host, 'UnlikeOtherAI', 'Research')}`)
    assert.equal(await page.locator('#documents-enabled').isChecked(), false)
    assert.equal(await page.locator('#documents-folder').textContent(), `${mainFolder(host)} (suggested)`)
    await assertFits(page, `${host} research off`)
    await shot('research-off')

    // Its switch turns on Research alone, in the shared main folder.
    await page.locator('#documents-switch').click()
    await destinationIs(page, `Research · UnlikeOtherAI’s documents go in ${shown(host, 'UnlikeOtherAI', 'Research')}`)
    assert.deepEqual(await callArgs(page, 'executor_sync_configure'), [
      { executorId: 'team-1', command: { command: 'configure', root: mainFolder(host), enabled: true, acceptExistingFiles: false } },
    ])
    await shot('research-on')

    // Switched off again, Research stops; Platform stays on and untouched.
    await page.locator('#documents-switch').click()
    await destinationIs(page, `Research · UnlikeOtherAI’s documents will go in ${shown(host, 'UnlikeOtherAI', 'Research')}`)
    assert.deepEqual((await callArgs(page, 'executor_sync_configure')).map((call) => [call.executorId, call.command.enabled]),
      [['team-1', true], ['team-1', false]])
    await selectTeam(page, 'team-0')
    await documentsFor(page, 'Platform · UnlikeOtherAI')
    assert.equal(await page.locator('#documents-enabled').isChecked(), true)
    await destinationIs(page, `Platform · UnlikeOtherAI’s documents go in ${shown(host, 'UnlikeOtherAI', 'Platform')}`)

    // A team that synced before teams shared a main folder keeps its one folder.
    await page.evaluate(() => Object.assign(window.teamSync['team-0'], { teamLabel: 'Platform', teamFolder: 'Platform' }))
    await showTab(page, 'documents')
    await destinationIs(page, `Platform · UnlikeOtherAI’s documents go in ${shown(host, 'Platform')}`)
    await shot('older-folder')

    // Before the computer knows the team's names, the line is not shown rather than guessed.
    await page.evaluate(() => Object.assign(window.teamSync['team-0'], { teamFolder: null }))
    await showTab(page, 'documents')
    await page.locator('#documents-destination').waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
    await context.close()
  }

  // Every locale fits in both window sizes; Czech and English pictures in light and dark.
  for (const locale of LOCALES) {
    for (const size of ['desktop', 'minimum']) {
      for (const dark of locale === 'cs' || locale === 'en-GB' ? [false, true] : [false]) {
        const { context, page, errors } = await open(browser, ui, { host: 'macos', locale, size, dark })
        const platform = await sentence(page, 'on', 'Platform · UnlikeOtherAI', shown('macos', 'UnlikeOtherAI', 'Platform'))
        await destinationIs(page, platform)
        await assertFits(page, `${locale} ${size} platform`)
        await selectTeam(page, 'team-1')
        const research = await sentence(page, 'off', 'Research · UnlikeOtherAI', shown('macos', 'UnlikeOtherAI', 'Research'))
        await destinationIs(page, research)
        await assertFits(page, `${locale} ${size} research`)
        if ((locale === 'cs' || locale === 'en-GB') && size === 'desktop') {
          await screenshot(page, output, `documents-teams-research-off-${locale}-${dark ? 'dark' : 'light'}`)
        }
        assert.deepEqual(errors, [])
        await context.close()
      }
    }
  }
  process.stdout.write('Documents for several teams: two teams in one main folder, one switched off, an older folder; both hosts, seven locales.\n')
}

/**
 * The same two teams as an older revision drew them, for side-by-side
 * comparison: the old document read with `git show`, the same fixtures.
 */
export const captureDocumentsTeamsBefore = async (browser, root, revision, output) => {
  await mkdir(output, { recursive: true })
  const listed = execFileSync('git', ['ls-tree', '--name-only', revision, 'packages/executor-console/'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((path) => path.split('/').pop())
  const resource = (file) => execFileSync('git', ['show', `${revision}:packages/executor-console/${file}`], { cwd: root, maxBuffer: 4_000_000 })
  for (const [host, locale, dark] of [['macos', 'en-GB', false], ['windows', 'en-GB', false], ['macos', 'cs', false], ['macos', 'cs', true]]) {
    const context = await browser.newContext({ viewport: SIZES.desktop, locale, colorScheme: dark ? 'dark' : 'light' })
    await installTeamsSyncHost(context, teamsFixtures(host))
    await installRendererHost(context, host, { paired: 2 })
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    await page.route('http://localhost:5875/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
      await route.fulfill({ body: listed.includes(file) ? resource(file) : '', contentType })
    })
    await page.goto('http://localhost:5875/')
    await showTab(page, 'documents')
    await page.locator('#documents-switch-label').waitFor()
    await page.waitForTimeout(600)
    const name = `${host}-documents-teams-${locale}-${dark ? 'dark' : 'light'}`
    await page.screenshot({ path: join(output, `${name}-platform-on.png`) })
    await selectTeam(page, 'team-1')
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(output, `${name}-research-off.png`) })
    await context.close()
  }
  process.stdout.write(`Captured Documents for two teams at ${revision} into ${output}\n`)
}
