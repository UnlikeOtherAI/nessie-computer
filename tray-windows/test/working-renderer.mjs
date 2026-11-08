// Now working journeys (contract §11.5): idle, two sessions with mixed
// commands, a command waiting for the owner that links to its request, Stop
// with its confirm, a refresh that leaves the page where it was, Czech, dark
// and the smallest window. Both hosts render the same document.
import assert from 'node:assert/strict'
import { assertFits, callCount, lastCall, openConsole, screenshot } from './renderer-page.mjs'

/** Two sessions as the daemon reports them: one agent running and reading, another queued behind capacity. */
const twoSessions = () => [
  { executorId: 'team-1', sessionId: 'session-a', agentName: 'Sales agent', startedAt: new Date().toISOString(), commands: [
    { id: 'c1', kind: 'program', status: 'running', program: 'npm', args: ['test'] },
    { id: 'c2', kind: 'file', status: 'running', operation: 'read', path: 'report.md' },
    { id: 'c3', kind: 'browser', status: 'running', site: 'https://docs.example.com/pricing' },
  ] },
  { executorId: 'team-0', sessionId: 'session-b', agentName: 'Jev', startedAt: new Date().toISOString(), commands: [
    { id: 'c4', kind: 'coding', status: 'running', program: 'Claude Code' },
    { id: 'c5', kind: 'file', status: 'queued', operation: 'write', path: 'notes/summary.md' },
    { id: 'c6', kind: 'mcp', status: 'queued', app: 'kelpie' },
  ] },
]
const waitingSession = () => ({ executorId: 'team-0', sessionId: 'session-c', startedAt: new Date().toISOString(), commands: [
  { id: 'c7', kind: 'program', status: 'waiting_for_owner', program: 'docker', args: ['build', '.'], requestId: 'req-1' },
] })
const request = () => ({ executorId: 'team-0', id: 'req-1', program: 'docker', args: ['build', '.'], agentName: 'An agent',
  requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90000).toISOString() })

export const verifyNowWorking = async (browser, ui, output) => {
  let journeys = 0
  const open = async (options) => {
    const opened = await openConsole(browser, ui, { sync: null, paired: 2, ...options })
    return { ...opened, shot: (name) => screenshot(opened.page, output, `${options.host}-working-${name}`) }
  }
  const commandTexts = (page, session) => page.locator(`.session[data-session="${session}"] .command`).allTextContents()

  for (const host of ['windows', 'macos']) {
    const { context, page, errors, shot } = await open({ host })
    const section = page.locator('#overview-working')
    // Idle: the section is there with its one sentence, below Needs you and above the team cards.
    await page.locator('#team-cards .team-card').nth(1).waitFor()
    await section.getByText('No agent is working on this computer right now.').waitFor()
    assert.equal(await page.locator('#overview-working-title').textContent(), 'Now working')
    assert.equal(await page.locator('#working-list').isHidden(), true)
    assert.ok(await page.evaluate(() => document.getElementById('overview-working').compareDocumentPosition(document.getElementById('overview-teams')) & Node.DOCUMENT_POSITION_FOLLOWING))
    await assertFits(page, `${host} idle`)
    await shot('idle')

    // Two sessions: each names its agent and team, with its commands in plain words beneath.
    await page.evaluate((sessions) => { window.sessions = sessions }, twoSessions())
    await page.locator('.session').nth(1).waitFor()
    assert.deepEqual(await page.locator('.session-title').allTextContents(), ['Sales agent · Research · UnlikeOtherAI', 'Jev · Platform · UnlikeOtherAI'])
    assert.deepEqual(await commandTexts(page, 'session-a'), ['running npm test', 'reading report.md', 'browsing docs.example.com'])
    assert.deepEqual(await commandTexts(page, 'session-b'), ['working in Claude Code', 'waiting to start: writing notes/summary.md', 'waiting to start: using kelpie'])
    assert.equal(await page.locator('.session[data-session="session-a"] code').first().textContent(), 'npm test')
    assert.equal(await page.locator('#working-empty').isHidden(), true)
    assert.equal(await page.getByRole('button', { name: 'Stop Sales agent · Research · UnlikeOtherAI' }).count(), 1)
    await assertFits(page, `${host} two sessions`)
    await shot('two-sessions')

    // A refresh updates rows where they stand: the same element, no page jump, focus kept.
    await page.locator('main').evaluate((main) => { main.scrollTop = 40 })
    await page.getByRole('button', { name: 'Stop Jev · Platform · UnlikeOtherAI' }).focus()
    const rowBefore = await page.locator('.session[data-session="session-a"]').evaluateHandle((node) => node)
    const reads = await callCount(page, 'executor_sessions')
    await page.evaluate(() => { window.sessions[0].commands.push({ id: 'c8', kind: 'file', status: 'running', operation: 'write', path: 'report.md' }) })
    await page.waitForFunction((before) => window.calls.filter((call) => call.command === 'executor_sessions').length > before, reads)
    await page.locator('.session[data-session="session-a"] .command').nth(3).getByText('writing report.md').waitFor()
    assert.equal(await page.evaluate((node) => node.isConnected && node === document.querySelector('.session[data-session="session-a"]'), rowBefore), true)
    assert.equal(await page.locator('main').evaluate((main) => main.scrollTop), 40)
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'session-b:stop')
    await page.locator('main').evaluate((main) => { main.scrollTop = 0 })

    // Waiting for you: the command names what waits and links to its request under Needs you.
    await page.evaluate(([session, pending]) => {
      window.sessions.push(session)
      window.requests = [pending]
      window.paired[0].pendingProgramRequests = 1
    }, [waitingSession(), request()])
    await page.locator('.session[data-session="session-c"]').waitFor()
    await page.locator('#needs-you-list [data-request="req-1"]').waitFor()
    assert.deepEqual(await commandTexts(page, 'session-c'), ['waiting for you: running docker build . Allow or don’t allow'])
    assert.equal(await page.locator('.session[data-session="session-c"] .session-title').textContent(), 'An agent · Platform · UnlikeOtherAI')
    await assertFits(page, `${host} waiting for you`)
    await shot('waiting-for-you')
    await page.getByRole('button', { name: 'Allow or don’t allow' }).click()
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-request]')?.dataset.request), 'req-1')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Allow once')
    await page.getByRole('button', { name: 'Don’t allow' }).click()
    await page.waitForFunction(() => !document.querySelector('#needs-you-list [data-request="req-1"]'))
    await page.evaluate(() => { window.sessions = window.sessions.filter((session) => session.sessionId !== 'session-c') })
    await page.waitForFunction(() => !document.querySelector('.session[data-session="session-c"]'))

    // Stop asks first; Cancel changes nothing; a refused stop is reported in the dialog; a stop removes the row and says so.
    await page.getByRole('button', { name: 'Stop Sales agent · Research · UnlikeOtherAI' }).click()
    await page.locator('#stop-session-dialog[open]').waitFor()
    assert.equal(await page.locator('#stop-session-title').textContent(), 'Stop Sales agent?')
    assert.equal(await page.locator('#stop-session-body').textContent(), 'Everything this agent is doing on this computer stops. It can start again unless you pause the team.')
    assert.equal(await page.evaluate(() => document.activeElement.id), 'stop-session-cancel')
    await shot('stop-confirm')
    await page.locator('#stop-session-cancel').click()
    await page.waitForFunction(() => !document.getElementById('stop-session-dialog').open)
    assert.equal(await callCount(page, 'executor_stop_session'), 0)
    assert.equal(await page.locator('.session').count(), 2)
    await page.evaluate(() => { window.failStop = 'The daemon did not answer.' })
    await page.getByRole('button', { name: 'Stop Sales agent · Research · UnlikeOtherAI' }).click()
    await page.locator('#stop-session-dialog[open]').waitFor()
    await page.locator('#stop-session-confirm').click()
    await page.locator('#stop-session-dialog .dialog-error').getByText('The daemon did not answer.').waitFor()
    assert.equal(await page.locator('#stop-session-dialog').evaluate((dialog) => dialog.open), true)
    assert.equal(await page.locator('#stop-session-confirm').textContent(), 'Stop')
    await page.evaluate(() => { window.failStop = null })
    await page.locator('#stop-session-confirm').click()
    await page.waitForFunction(() => !document.getElementById('stop-session-dialog').open)
    assert.deepEqual((await lastCall(page, 'executor_stop_session')).args, { executorId: 'team-1', sessionId: 'session-a' })
    await page.waitForFunction(() => document.querySelectorAll('.session').length === 1)
    assert.equal(await page.locator('.session-title').textContent(), 'Jev · Platform · UnlikeOtherAI')
    assert.equal(await page.locator('#save-status').textContent(), 'Sales agent was stopped.')
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'session-b:stop')
    await shot('stopped')
    // The last session ending brings the sentence back; a host that cannot answer says so beside the list and keeps what it had.
    await page.evaluate(() => { window.sessions = [] })
    await section.getByText('No agent is working on this computer right now.').waitFor()
    await page.evaluate(() => { window.sessionsOffline = true })
    await page.locator('#working-error').getByText('Couldn’t read what agents are doing here.').waitFor()
    await page.evaluate(() => { window.sessionsOffline = false })
    await page.waitForFunction(() => document.getElementById('working-error').hidden)
    // Another tab stops the reads; coming back asks again.
    await page.getByRole('tab', { name: 'Settings' }).click()
    const idle = await callCount(page, 'executor_sessions')
    await page.waitForTimeout(3500)
    assert.equal(await callCount(page, 'executor_sessions'), idle)
    await page.getByRole('tab', { name: 'Overview' }).click()
    await page.waitForFunction((before) => window.calls.filter((call) => call.command === 'executor_sessions').length > before, idle)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }

  // No team yet: nothing to list, nothing asked.
  {
    const { context, page, errors } = await open({ host: 'macos', paired: 0 })
    await page.locator('#overview-welcome-connect').waitFor()
    assert.equal(await page.locator('#overview-working').isHidden(), true)
    assert.equal(await callCount(page, 'executor_sessions'), 0)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Czech: every word the section owns, with sessions and in the Stop dialog.
  {
    const { context, page, errors, shot } = await open({ host: 'macos', locale: 'cs-CZ' })
    await page.locator('#overview-working').getByText('Na tomto počítači teď žádný agent nepracuje.').waitFor()
    assert.equal(await page.locator('#overview-working-title').textContent(), 'Právě pracuje')
    await page.evaluate((sessions) => { window.sessions = [...sessions, { ...sessions[0], sessionId: 'session-c', commands: [
      { id: 'c7', kind: 'program', status: 'waiting_for_owner', program: 'docker', args: ['build', '.'], requestId: 'req-1' }] }] }, twoSessions())
    await page.locator('.session').nth(2).waitFor()
    assert.deepEqual(await commandTexts(page, 'session-a'), ['spouští npm test', 'čte report.md', 'prohlíží docs.example.com'])
    assert.deepEqual(await commandTexts(page, 'session-b'), ['pracuje v Claude Code', 'čeká na spuštění: zapisuje notes/summary.md', 'čeká na spuštění: používá kelpie'])
    assert.deepEqual(await commandTexts(page, 'session-c'), ['čeká na vás: spouští docker build . Povolit, nebo nepovolit'])
    await assertFits(page, 'cs sessions')
    await shot('two-sessions-cs')
    await page.locator('.session[data-session="session-a"] .session-stop').click()
    assert.equal(await page.locator('#stop-session-title').textContent(), 'Zastavit Sales agent?')
    assert.equal(await page.locator('#stop-session-confirm').textContent(), 'Zastavit')
    assert.equal(await page.locator('#stop-session-cancel').textContent(), 'Zrušit')
    await shot('stop-confirm-cs')
    await page.locator('#stop-session-confirm').click()
    await page.waitForFunction(() => document.querySelectorAll('.session').length === 2)
    assert.equal(await page.locator('#save-status').textContent(), 'Sales agent byl zastaven.')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Every other locale renders the section with sessions and the Stop dialog without a missing word.
  for (const locale of ['en-US', 'de', 'es', 'fr', 'it']) {
    const { context, page, errors } = await open({ host: 'windows', locale })
    await page.evaluate((sessions) => { window.sessions = [...sessions, { ...sessions[0], sessionId: 'session-c', commands: [
      { id: 'c7', kind: 'program', status: 'waiting_for_owner', program: 'docker', args: ['build'], requestId: 'req-1' }] }] }, twoSessions())
    await page.locator('.session').nth(2).waitFor()
    await page.locator('.session[data-session="session-a"] .session-stop').click()
    await page.locator('#stop-session-dialog[open]').waitFor()
    await assertFits(page, `${locale} stop dialog`)
    await page.keyboard.press('Escape')
    await assertFits(page, `${locale} sessions`)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // Dark follows the OS: the same tokens on the rows and the dialog.
  {
    const { context, page, errors, shot } = await open({ host: 'windows', dark: true })
    await page.evaluate((sessions) => { window.sessions = [...sessions, { ...sessions[0], sessionId: 'session-c', commands: [
      { id: 'c7', kind: 'program', status: 'waiting_for_owner', program: 'docker', args: ['build', '.'], requestId: 'req-1' }] }] }, twoSessions())
    await page.locator('.session').nth(2).waitFor()
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
    await shot('two-sessions-dark')
    await page.locator('.session[data-session="session-a"] .session-stop').click()
    await page.locator('#stop-session-dialog[open]').waitFor()
    await shot('stop-confirm-dark')
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  // The smallest window the apps allow: rows wrap, the Stop button stays a finger's size, nothing clips.
  for (const [locale, dark] of [['en-GB', false], ['cs-CZ', true]]) {
    const { context, page, errors, shot } = await open({ host: 'macos', locale, dark, size: 'minimum' })
    const suffix = `${locale === 'cs-CZ' ? '-cs' : ''}${dark ? '-dark' : ''}-min`
    await page.evaluate((sessions) => { window.sessions = [...sessions, { ...sessions[0], sessionId: 'session-c', commands: [
      { id: 'c7', kind: 'program', status: 'waiting_for_owner', program: 'docker', args: ['build', '.'], requestId: 'req-1' }] }] }, twoSessions())
    await page.locator('.session').nth(2).waitFor()
    assert.ok((await page.locator('.session-stop').first().boundingBox()).height >= 44)
    await assertFits(page, `${locale} minimum`)
    await shot(`two-sessions${suffix}`)
    await page.locator('.session[data-session="session-a"] .session-stop').click()
    await page.locator('#stop-session-dialog[open]').waitFor()
    await assertFits(page, `${locale} minimum stop dialog`)
    await shot(`stop-confirm${suffix}`)
    assert.deepEqual(errors, [])
    journeys++
    await context.close()
  }
  process.stdout.write(`${journeys} Now working journeys passed; pictures ${output}\n`)
}
