// The native host both apps give the team tabs, as a page-side fake: every
// command the tabs call, with the describe and configure shapes of contract
// §4.3–4.6 and §5.1. Nothing here starts, stops or restarts a team.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installSyncHost, syncState, syncTrash } from './sync-fixtures.mjs'
import { teamTabsHtml, TEAM_TAB_FILES } from './team-tabs-shell.mjs'

export const NEW_POLICY = { mode: 'allowlist', allowlist: [], denylist: [], trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true } }
export const OLD_POLICY = { mode: 'all', allowlist: [], denylist: ['rm *'] }

export const installTeamTabsHost = async (context, host, { legacy = false } = {}) => {
  await context.addInitScript(({ host, legacy }) => {
    window.calls = []
    window.teamNames = { 'team-0': { teamName: 'Platform', organizationName: 'UnlikeOtherAI' }, 'team-1': { teamName: 'Research', organizationName: 'UnlikeOtherAI' } }
    window.paired = [{ executorId: 'team-0', daemonStatus: 'running', paused: false, pendingProgramRequests: 0 },
      { executorId: 'team-1', daemonStatus: 'running', paused: false, pendingProgramRequests: 0 }]
    const home = host === 'windows' ? 'C:\\Users\\person' : '/Users/person'
    const sep = host === 'windows' ? '\\' : '/'
    window.teams = {
      'team-0': {
        folders: [{ name: 'nessie', path: `${home}${sep}Nessie` }, { name: 'shared', path: host === 'windows' ? 'C:\\Users\\Public' : '/Users/Shared' }],
        policy: { mode: 'allowlist', allowlist: [], denylist: [], trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true } },
        existingSessions: true, allowedOrigins: [], browserConfigured: false,
        mcpPolicy: legacy ? undefined : { mode: 'installed', disabled: [] },
        localApps: legacy ? undefined : [{ name: 'kelpie', source: 'unlikeotherai', enabled: true, installed: true },
          { name: 'filesystem', source: 'claudeCode', enabled: true, installed: true }, { name: 'figma', source: 'codex', enabled: true, installed: false }],
      },
      'team-1': {
        folders: [{ name: 'notes', path: `${home}${sep}Notes` }],
        policy: { mode: 'all', allowlist: [], denylist: ['rm *'] },
        existingSessions: false, allowedOrigins: ['https://docs.example.com'], browserConfigured: true,
        mcpPolicy: { mode: 'installed', disabled: ['kelpie'] },
        localApps: [{ name: 'kelpie', source: 'unlikeotherai', enabled: false, installed: true }],
      },
    }
    window.chosen = [`${home}${sep}Projects${sep}Site`]
    window.restarts = 0
    const describe = (id) => {
      const team = window.teams[id]
      return {
        executorId: id, apiBaseUrl: 'https://api.nessie.works', commandPolicy: JSON.parse(JSON.stringify(team.policy)),
        programDefaults: ['unlikeotherai', 'claudeCode', 'codex', 't3Code'],
        existingCodingSessionsEnabled: team.existingSessions,
        existingClaudeChannelConfiguration: { mcpServers: { nessie: { command: 'node', args: ['nessie-executor.cjs', 'serve-existing-claude-channel', '--state-dir', id] } } },
        policy: { operations: ['file.read'], permittedPrograms: [], revision: 1 },
        reach: { folders: team.folders.map((folder) => ({ ...folder })), allowedOrigins: [...team.allowedOrigins], guestSessions: 'available', mcpServers: [] },
        sandbox: { browserConfigured: team.browserConfigured, codingConfigured: false, promotionHelperConfigured: false },
        ...(team.mcpPolicy ? { mcpPolicy: { ...team.mcpPolicy, disabled: [...team.mcpPolicy.disabled] } } : {}),
        ...(team.localApps ? { localApps: team.localApps.map((app) => ({ ...app, enabled: !team.mcpPolicy?.disabled.includes(app.name) })) } : {}),
      }
    }
    const invoke = async (command, args = {}) => {
      window.calls.push({ command, args })
      const id = args.executorId
      if (window.syncHost && (command.startsWith('executor_sync_') || command === 'executor_open_path')) return window.syncHost(command, args)
      if (command === 'executor_describe' || command === 'executor_console_describe') {
        if (window.failDescribe) throw new Error(window.failDescribe)
        return describe(id)
      }
      if (command === 'executor_configure') {
        if (window.failConfigure) throw new Error(window.failConfigure)
        const input = args.configurationInput
        const team = window.teams[id]
        window.configured = (window.configured ?? []).concat([{ id, input }])
        if (input.workspaceFolders) team.folders = input.workspaceFolders
        if (input.commandPolicy) team.policy = input.commandPolicy
        if (input.existingCodingSessionsEnabled !== undefined) team.existingSessions = input.existingCodingSessionsEnabled
        if (input.allowedOrigins) team.allowedOrigins = input.allowedOrigins
        if (input.mcpPolicy) team.mcpPolicy = input.mcpPolicy
        // The daemon applies this live: its status is untouched, and nothing restarts.
        if (window.failAfterWrite) throw new Error(window.failAfterWrite)
        return describe(id)
      }
      if (command === 'executor_choose_folder') return window.chosen.shift() ?? null
      if (command === 'executor_personal_chatgpt') {
        if (window.chatgptOffline) throw new Error('offline')
        const operation = args.operation
        window.chatgptProfiles ??= []
        if (operation.newProfileId && !window.chatgptProfiles.some((p) => p.profileId === operation.newProfileId)) {
          window.chatgptProfiles.push({ profileId: operation.newProfileId, label: operation.label, phase: 'disconnected', planEnabled: false,
            reason: null, operationId: null, backgroundConsentRevision: null })
        }
        const profile = window.chatgptProfiles.find((p) => p.profileId === (operation.newProfileId ?? operation.profileId))
        if (operation.operation === 'rename') profile.label = operation.label
        if (operation.operation === 'start') { profile.phase = 'ready'; profile.planEnabled = true }
        if (operation.operation === 'background-consent') {
          if (operation.expectedRevision !== profile.backgroundConsentRevision) throw new Error('stale permission')
          profile.backgroundConsentRevision = operation.enabled ? (window.backgroundRevision = (window.backgroundRevision ?? 0) + 1) : null
        }
        if (['disconnect', 'cancel'].includes(operation.operation)) { profile.phase = 'disconnected'; profile.planEnabled = false; profile.backgroundConsentRevision = null }
        return { version: 1, profiles: window.chatgptProfiles.map((p) => ({ ...p })), reason: window.chatgptReason ?? null,
          restriction: 'unisolated_terminal_coding_and_custom_stdio_blocked' }
      }
      if (command === 'executor_inference_connections') {
        if (window.endpointOffline) throw new Error('offline')
        window.endpoints ??= []
        const operation = args.operation
        if (operation.operation === 'save') {
          window.endpoints = window.endpoints.filter((endpoint) => endpoint.id !== operation.id)
          window.endpoints.push({ id: operation.id, name: operation.name, baseUrl: operation.baseUrl, scope: operation.scope,
            hasApiKey: Boolean(operation.apiKey), status: 'online', models: ['qwen3'] })
        }
        if (operation.operation === 'remove') window.endpoints = window.endpoints.filter((endpoint) => endpoint.id !== operation.id)
        return { endpoints: window.endpoints.map((endpoint) => ({ ...endpoint })) }
      }
      if (['executor_set_running', 'executor_reconnect', 'executor_set_paused'].includes(command)) window.restarts += 1
      return null
    }
    const listeners = {}
    if (host === 'windows') {
      window.__TAURI__ = { core: { invoke }, event: { listen: async (event, handler) => { (listeners[event] ??= []).push(handler); return () => undefined } } }
    } else {
      window.webkit = { messageHandlers: { executor: { postMessage: ({ command, args }) => invoke(command, args) } } }
    }
  }, { host, legacy })
}

/** Opens the shell page with the team tabs for one host, locale, width and colour scheme. */
export const openTeamTabs = async (browser, ui, { host, locale = 'en-GB', width = 1280, height = 1800, dark = false, legacy = false, sync = null }) => {
  const context = await browser.newContext({ locale, viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' })
  await installTeamTabsHost(context, host, { legacy })
  await installSyncHost(context, sync ?? syncState(host), syncTrash)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(12000)
  await page.route('http://localhost:5876/**', async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    if (file === 'index.html') { await route.fulfill({ body: teamTabsHtml(), contentType: 'text/html' }); return }
    assert.ok(TEAM_TAB_FILES.includes(file), file)
    await route.fulfill({ body: await readFile(join(ui, file)), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' })
  })
  await page.goto('http://localhost:5876/')
  return { context, page, errors }
}

export const lastCall = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).at(-1), command)
export const calls = (page, command) => page.evaluate((name) => window.calls.filter((call) => call.command === name).map((call) => call.args), command)
/** Nothing in the open tab or dialog runs past its box, and no word key leaked onto the page. */
export const assertFits = async (page, label) => {
  const problems = await page.evaluate(() => {
    const found = []
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth) found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`)
    const scopes = [...document.querySelectorAll('[role=tabpanel]:not([hidden])'), ...document.querySelectorAll('dialog[open]')]
    for (const scope of scopes) {
      const edge = scope.getBoundingClientRect().right + 0.5
      for (const node of [scope, ...scope.querySelectorAll('*')]) {
        if (node.closest('[hidden]') || !node.getClientRects().length || node.tagName === 'TEXTAREA' || node.classList.contains('visually-hidden') || node.getAttribute('aria-hidden') === 'true') continue
        const box = node.getBoundingClientRect()
        const name = node.id || node.className || node.tagName
        if (box.right > edge) found.push(`${name} runs past its container by ${Math.round(box.right - edge)}px`)
        if (['BUTTON', 'P', 'H2', 'H3', 'LI', 'SPAN', 'SMALL', 'LABEL'].includes(node.tagName) && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
          found.push(`${name} clips its text`)
        }
      }
    }
    if (window.missingWords?.length) found.push(`missing words: ${[...new Set(window.missingWords)].join(', ')}`)
    if (/\b(access|documents|ai|chatgpt)\.[a-zA-Z.]+/.test(document.body.innerText)) found.push('a word key leaked onto the page')
    return found
  })
  assert.deepEqual(problems, [], label)
}
