// A fake native host for the shared console: every §5.1 bridge command, for
// both host flavours. State lives on `window` so a journey can read and poke
// it; only the process-local transport differs between hosts. Nothing here
// starts, stops or restarts a team: a save is applied live, as the runtime does.
export const NEW_POLICY = { mode: 'allowlist', allowlist: [], denylist: [], trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true } }
export const OLD_POLICY = { mode: 'all', allowlist: [], denylist: ['rm *'] }

/**
 * `paired` is how many teams start connected (true = 1). `legacy` describes
 * them as an older runtime would, without `localApps` or `mcpPolicy`.
 */
export const installRendererHost = async (context, host, { paired = 0, legacy = false, unnamed = false, unreadable = false, pairStatus = 'idle' } = {}) => {
await context.addInitScript(({ host, paired, legacy, unnamed, unreadable, pairStatus, NEW_POLICY, OLD_POLICY }) => {
  // A team that has never had a name: its row carries no `names` (docs/team-names.md).
  window.unnamed = unnamed
  window.calls = []
  window.pairStatus = pairStatus
  // An attempt the app last showed long ago: its code ran out a month before this launch.
  if (pairStatus === 'expired') window.expiresAt = new Date(Date.now() - 30 * 86400000).toISOString()
  window.paired = []
  window.teams = {} // executorId → { folders, policy, existingSessions, allowedOrigins, browserConfigured, mcpPolicy?, localApps? }
  window.requests = []
  window.remedies = []
  window.syncStates = {}
  window.enabled = false
  window.autoRestart = true
  window.restarts = 0
  window.updateStatus = { format: 1, installedVersion: '1.0.0', sourceCommit: 'a'.repeat(40),
    automatic: true, channel: 'stable', phase: 'idle', canInstall: true, notify: false }
  const home = host === 'windows' ? 'C:\\Users\\person' : '/Users/person'
  const sep = host === 'windows' ? '\\' : '/'
  window.chosen = [`${home}${sep}Projects${sep}Site`]
  const teamNames = ['Platform', 'Research', 'Sales']
  // Discovered local apps as the runtime reports them (`describeLocalApps`): the source is where it was found.
  const discovered = [{ name: 'kelpie', source: 'unlikeotherai', command: ['kelpie', 'mcp'], installed: true },
    { name: 'filesystem', source: 'claude-code', command: ['npx', 'mcp-filesystem'], installed: true },
    { name: 'figma', source: 'codex', command: ['figma-mcp'], installed: false }]
  const row = (executorId, extra = {}) => ({ executorId, daemonStatus: 'running', paused: false, pendingProgramRequests: 0, workspaceConfigured: true,
    ...(host === 'windows' ? { connection: 'user' } : {}), ...extra })
  // Every row carries its team's saved label, as both hosts send it.
  const namesFor = (index) => ({ organizationName: 'UnlikeOtherAI', teamName: teamNames[index] ?? `Team ${index}`,
    apiBaseUrl: window.pairServer ?? 'https://api.nessie.works' })
  // The person enters the code in Nessie: the claim alone pairs, and the host starts the daemon.
  // The first team is a new pairing (one folder, the defaults); the second is an older team with its own rules, for contrast.
  window.claimInNessie = () => {
    window.pairStatus = 'paired'
    const executorId = `team-${window.paired.length}`
    const second = window.paired.length === 1
    window.paired.push(row(executorId, window.unnamed ? {} : { names: namesFor(window.paired.length) }))
    window.teams[executorId] = second ? {
      folders: [{ name: 'notes', path: `${home}${sep}Notes` }], policy: JSON.parse(JSON.stringify(OLD_POLICY)), existingSessions: false,
      allowedOrigins: ['https://docs.example.com'], browserConfigured: true,
      mcpPolicy: { mode: 'installed', disabled: ['kelpie'] }, discovered: [discovered[0]], mcpServers: [],
    } : {
      folders: [{ name: 'nessie', path: `${home}${sep}Nessie` }],
      policy: JSON.parse(JSON.stringify(NEW_POLICY)), existingSessions: true, allowedOrigins: [], browserConfigured: false,
      // One app the owner named, beside the discovered ones.
      mcpServers: [{ name: 'my-tool', command: ['node', 'my-tool.js'] }],
      ...(legacy ? {} : { mcpPolicy: { mode: 'installed', disabled: [] }, discovered: discovered.map((app) => ({ ...app })) }),
    }
    return executorId
  }
  // On Windows the team's ChatGPT plans live on a second, service-owned connection to the same team.
  window.claimPlanInNessie = (executorId) => {
    const planId = `${executorId}-plans`
    window.planPairStatus = 'paired'
    const team = window.paired.find((entry) => entry.executorId === executorId)
    window.paired.push(row(planId, { connection: 'service', ...(team.names ? { names: { ...team.names } } : {}) }))
    window.teams[planId] = { ...window.teams[executorId], folders: [{ name: 'nessie', path: `${home}${sep}Nessie` }] }
    window.paired.find((entry) => entry.executorId === executorId).chatgptConnectionId = planId
    return planId
  }
  const view = () => ({ kind: 'reachable', executors: window.paired.map((entry) => ({ ...entry })) })
  // `describe.programDefaults` as the runtime reports it (`src/program-trust.ts`).
  const programDefaults = () => [
    { id: 'unlikeotherai', verifiedBy: 'signature', available: !window.uoaSignatureUnavailable },
    { id: 'claudeCode', verifiedBy: 'name', program: 'claude', available: true },
    { id: 'codex', verifiedBy: 'name', program: 'codex', available: true },
    { id: 't3Code', verifiedBy: 'name', program: 't3', available: true },
  ]
  const describe = (id) => {
    const team = window.teams[id]
    const entry = window.paired.find((item) => item.executorId === id)
    const localApps = team.discovered ? [
      ...team.mcpServers.map((server) => ({ name: server.name, source: 'configured', enabled: true, installed: true })),
      ...team.discovered.map((app) => {
        const enabled = app.installed && !team.mcpPolicy?.disabled.includes(app.name)
        return { name: app.name, source: app.source, enabled, installed: app.installed,
          ...(enabled ? {} : { reason: app.installed ? 'switched_off' : 'not_installed' }) }
      }),
    ] : undefined
    return {
      executorId: id, apiBaseUrl: 'https://api.nessie.works', commandPolicy: JSON.parse(JSON.stringify(team.policy)),
      programDefaults: programDefaults(),
      paused: entry?.paused ?? false, pendingProgramRequests: entry?.pendingProgramRequests ?? 0,
      existingCodingSessionsEnabled: team.existingSessions,
      existingClaudeChannelConfiguration: { mcpServers: { nessie: { command: 'node', args: ['nessie-executor.cjs', 'serve-existing-claude-channel', '--state-dir', id] } } },
      policy: { operations: ['file.read'], permittedPrograms: [], revision: 1 },
      reach: { folders: team.folders.map((folder) => ({ ...folder })), allowedOrigins: [...team.allowedOrigins],
        guestSessions: team.folders.length === 1 ? 'available' : 'refused_multiple_folders',
        mcpServers: [...team.mcpServers.map((server) => ({ ...server })), ...(team.discovered ?? []).map((app) => ({ name: app.name, command: app.command, source: app.source }))] },
      sandbox: { browserConfigured: team.browserConfigured, codingConfigured: false, promotionHelperConfigured: false },
      ...(team.mcpPolicy ? { mcpPolicy: { ...team.mcpPolicy, disabled: [...team.mcpPolicy.disabled] } } : {}),
      ...(localApps ? { localApps } : {}),
    }
  }
  const pairingView = (status, executorId) => ({ status, code: '01234567',
    expiresAt: window.expiresAt ?? new Date(Date.now() + 290000).toISOString(), machineName: 'My computer',
    ...(executorId ? { executorId } : {}), apiBaseUrl: window.pairServer ?? 'https://api.nessie.works' })
  /** The service-owned connection a ChatGPT plan needs on Windows: one more pairing code for the same team. */
  const planConnection = (command, id) => {
    if (host !== 'windows') throw new Error(`Unknown command ${command}`)
    const entry = window.paired.find((item) => item.executorId === id)
    if (!entry || entry.connection !== 'user') throw new Error('This team already has a connection for ChatGPT plans.')
    if (command === 'executor_chatgpt_connection_start') {
      if (window.planStartFails) throw new Error(window.planStartFails)
      window.planPairStatus = 'waiting'
    }
    if (command === 'executor_chatgpt_connection_cancel') window.planPairStatus = 'cancelled'
    return pairingView(window.planPairStatus ?? 'idle', entry.chatgptConnectionId)
  }
  const chatgpt = (operation) => {
    if (window.chatgptOffline) throw new Error('offline')
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
  const endpoints = (operation) => {
    if (window.endpointOffline) throw new Error('offline')
    window.endpoints ??= []
    if (operation.operation === 'save') {
      window.endpoints = window.endpoints.filter((endpoint) => endpoint.id !== operation.id)
      window.endpoints.push({ id: operation.id, name: operation.name, baseUrl: operation.baseUrl, scope: operation.scope,
        hasApiKey: Boolean(operation.apiKey), status: 'online', models: ['qwen3'] })
    }
    if (operation.operation === 'remove') window.endpoints = window.endpoints.filter((endpoint) => endpoint.id !== operation.id)
    return { endpoints: window.endpoints.map((endpoint) => ({ ...endpoint })) }
  }
  // Claude Code and Codex on this computer (ai-local.js): accounts are the computer's, switches each team's.
  const localAi = (command, args) => {
    if (window.localAiOffline) throw new Error('offline')
    if ((window.localAiService ?? []).includes(args.executorId)) return { unavailable: 'service' }
    window.localAiAccounts ??= []
    window.localAiPrograms ??= { 'claude-code': { installed: true, signedIn: true, account: 'person@example.com' },
      codex: { installed: false, signedIn: false } }
    // On by default: only a team's explicit off is kept.
    const off = ((window.localAiOff ??= {})[args.executorId] ??= [])
    const key = (engine, profileId) => (profileId ? `${engine}:${profileId}` : engine)
    if (command === 'executor_set_local_ai') {
      const name = key(args.engine, args.profileId)
      window.localAiOff[args.executorId] = args.available ? off.filter((entry) => entry !== name) : [...new Set([...off, name])]
    }
    if (command === 'executor_local_ai_add_account') {
      window.localAiAccounts.push({ engine: args.engine, profileId: `00000000-0000-4000-8000-00000000000${window.localAiAccounts.length + 1}`,
        name: args.name, signedIn: false })
    }
    if (command === 'executor_local_ai_remove_account') {
      window.localAiAccounts = window.localAiAccounts.filter((account) => account.profileId !== args.profileId)
    }
    const switchedOff = window.localAiOff[args.executorId]
    const row = (engine, profileId, name, program) => {
      const available = !switchedOff.includes(key(engine, profileId))
      return { engine, profileId, name, installed: program.installed, signedIn: program.signedIn,
        ...(program.account ? { account: program.account } : {}), available,
        offered: available && program.installed && program.signedIn ? window.localAiOffered ?? 'yes' : 'no' }
    }
    return [row('claude-code', null, null, window.localAiPrograms['claude-code']), row('codex', null, null, window.localAiPrograms.codex),
      ...window.localAiAccounts.map((account) => row(account.engine, account.profileId, account.name,
        { installed: window.localAiPrograms[account.engine].installed, signedIn: account.signedIn, account: account.signedIn ? 'work@example.com' : undefined }))]
  }
  const updates = (command, args) => {
    if (command === 'executor_update_setup') {
      if (window.updateSetupDenied) throw new Error('update.coordinator_unavailable')
      window.updateStatus = { ...window.updateStatus, phase: 'idle', canInstall: true, code: undefined }
      return { ...window.updateStatus }
    }
    if (window.updateUnavailable) throw new Error('update.coordinator_unavailable')
    const request = args.request
    if (request.operation === 'automatic') window.updateStatus.automatic = request.enabled
    if (request.operation === 'remind') window.updateStatus.notify = false
    if (request.operation === 'install') window.updateStatus = { ...window.updateStatus,
      targetVersion: window.updateStatus.availableVersion, phase: 'downloading', notify: false }
    return { ...window.updateStatus }
  }
  const invoke = async (command, args = {}) => {
    window.calls.push({ command, args })
    if (['executor_update_setup', 'executor_update_control'].includes(command)) return updates(command, args)
    const id = args.executorId
    if (command === 'executor_sync_status' && !window.syncHost) {
      return window.syncStates[id] ?? { executorId: id, enabled: false, paused: false, state: 'off', counts: {}, conflicts: [], heldDeletes: null }
    }
    if (window.syncHost && (command.startsWith('executor_sync_') || command === 'executor_open_path')) return window.syncHost(command, args)
    if (command === 'executor_personal_chatgpt') {
      // On Windows only the service can hold a plan's sign-in (requireChatgptServiceAuthority).
      if (host === 'windows' && window.paired.find((entry) => entry.executorId === id)?.connection !== 'service') {
        throw new Error('ChatGPT plans need the service connection.')
      }
      return chatgpt(args.operation)
    }
    if (command.startsWith('executor_chatgpt_connection_')) return planConnection(command, id)
    if (command === 'executor_launch_link') {
      if (host !== 'windows') throw new Error('Unknown command executor_launch_link')
      const link = window.launchLink ?? null
      window.launchLink = null
      return link
    }
    if (command.startsWith('executor_local_ai') || command === 'executor_set_local_ai') return localAi(command, args)
    if (command === 'executor_inference_connections') return endpoints(args.operation)
    if (command === 'executor_view') return view()
    if (command === 'executor_set_paused') {
      if (window.failPause) throw new Error(window.failPause)
      for (const row of window.paired) if (id === null || id === undefined || row.executorId === id) row.paused = args.paused
      return view()
    }
    if (command === 'executor_apply_remedy') {
      window.remedies.push({ executorId: id, remedy: args.remedy })
      const row = window.paired.find((entry) => entry.executorId === id)
      delete row.failure
      row.daemonStatus = 'running'
      return view()
    }
    if (command === 'executor_program_requests') return window.requests.filter((request) => !id || request.executorId === id)
    if (command === 'executor_answer_program_request') {
      const request = window.requests.find((entry) => entry.id === args.id)
      window.answers = (window.answers ?? []).concat([{ id: args.id, answer: args.answer }])
      window.requests = window.requests.filter((entry) => entry.id !== args.id)
      const row = window.paired.find((entry) => entry.executorId === id)
      row.pendingProgramRequests = Math.max(0, row.pendingProgramRequests - 1)
      if (args.answer === 'always' && request) window.teams[id].policy.allowlist.push(`${request.program} *`)
      return window.requests.slice()
    }
    if (command === 'executor_open_logs' || command === 'executor_open_nessie') return null
    if (command === 'executor_remove') {
      window.paired = window.paired.filter((row) => row.executorId !== id)
      return { signedOff: !window.removeUntold }
    }
    if (command === 'executor_choose_folder') return window.chosen.shift() ?? null
    if (command === 'executor_pairing_start') {
      if (window.pairingFailure) throw new Error(window.pairingFailure)
      if ('replace' in args || 'personalPlanConnection' in args) throw new Error('executor_pairing_start no longer takes options')
      if (!args.apiBaseUrl.startsWith('https://')) throw new Error('The server address must start with https://.')
      // As the runtime does: an accepted address answers a code still waiting, and never replaces it.
      const live = window.pairStatus === 'waiting' && !(window.expiresAt && Date.parse(window.expiresAt) <= Date.now())
      if (!live) {
        window.pairServer = args.apiBaseUrl
        window.pairStatus = 'waiting'
        window.expiresAt = undefined
      }
    }
    if (command === 'executor_pairing_cancel') {
      if (window.cancelFailure) throw new Error(window.cancelFailure)
      window.pairStatus = 'cancelled'
    }
    if (command.startsWith('executor_pairing_')) {
      const executorId = id ?? `team-${window.paired.length - 1}`
      const index = Number(executorId.split('-')[1])
      return { ...pairingView(id ? 'paired' : window.pairStatus, executorId),
        organizationName: 'UnlikeOtherAI', teamName: teamNames[index] ?? `Team ${index}` }
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
      if (input.mcpServers) team.mcpServers = input.mcpServers
      if (input.mcpServerRemovals) team.mcpServers = team.mcpServers.filter((server) => !input.mcpServerRemovals.includes(server.name))
      // The daemon applies this live: its status is untouched, and nothing restarts.
      if (window.failAfterWrite) throw new Error(window.failAfterWrite)
      return describe(id)
    }
    if (['executor_describe', 'executor_console_describe'].includes(command)) {
      if (window.failDescribe) throw new Error(window.failDescribe)
      return describe(id)
    }
    if (command === 'executor_autostart') return { enabled: window.enabled }
    if (command === 'executor_set_autostart') {
      if (window.failAutostart) throw new Error(window.failAutostart)
      window.enabled = args.enabled
    }
    if (command === 'executor_auto_restart') return { enabled: window.autoRestart }
    if (command === 'executor_set_auto_restart') window.autoRestart = args.enabled
    // Removed by contract §5.1 and §13: a call to one of these is a defect the journeys catch.
    if (['executor_set_running', 'executor_reconnect', 'executor_notify', 'executor_hide_status', 'executor_audience', 'executor_sessions',
      'executor_stop_session'].includes(command)) {
      window.restarts += 1
      throw new Error(`${command} no longer exists`)
    }
    return null
  }
  // A tray or menu bar event, delivered as each host delivers it: a Tauri event
  // carrying `payload`, or a macOS CustomEvent carrying `detail`.
  const trayListeners = {}
  if (host === 'windows') {
    window.__TAURI__ = { core: { invoke }, event: { listen: async (event, handler) => {
      (trayListeners[event] ??= []).push(handler)
      return () => undefined
    } } }
    window.emitTray = (event, payload) => { for (const handler of trayListeners[event] ?? []) handler({ event, payload }) }
  } else {
    window.webkit = { messageHandlers: { executor: { postMessage: ({ command, args }) => invoke(command, args) } } }
    window.emitTray = (event, payload) => window.dispatchEvent(new CustomEvent(event, { detail: payload }))
  }
  for (let count = Number(paired); count > 0; count -= 1) window.claimInNessie()
  // A paired team whose `describe` the installed runtime refuses: the Mac lists it by its folder, with no names.
  if (unreadable) {
    window.paired.push(row('unreadable-6F1C2D0A', { daemonStatus: 'running' }))
    window.failDescribe = '{"code":"EXECUTOR_MANAGED_RELEASE_REJECTED","status":"rejected"}'
  }
}, { host, paired, legacy, unnamed, unreadable, pairStatus, NEW_POLICY, OLD_POLICY })
}

/** Every file `index.html` loads, shell and team tabs alike, in load order. */
export const consoleFiles = {
  shell: ['index.html', 'style.css', 'native.js', 'i18n.js', 'help.js', 'main.js', 'errors-words.js', 'errors.js', 'teams-words.js', 'teams.js',
    'needs-words.js', 'needs.js', 'pairing-words.js', 'pairing.js', 'updates-words.js', 'update-notes.js', 'updates.js', 'settings-words.js', 'settings.js'],
  teamTabs: ['autosave.js', 'team-drafts.js', 'access-words.js', 'access.js', 'access-sections.js', 'access-programs.js',
    'documents-reasons-words.js', 'documents-words.js', 'documents.js', 'ai-local-words.js', 'ai-local.js', 'ai-words.js', 'ai.js', 'chatgpt-words.js', 'chatgpt.js',
    'ai-connection.js', 'inference-endpoints.js'],
}
