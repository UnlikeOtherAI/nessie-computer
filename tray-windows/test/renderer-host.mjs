// A fake native host for the shared console: every §5.1 bridge command, for
// both host flavours. State lives on `window` so a journey can read and poke
// it; only the process-local transport differs between hosts.
export const installRendererHost = async (context, host, { paired = false, ownerConfirmationRequired = false } = {}) => {
await context.addInitScript(({ host, paired, ownerConfirmationRequired }) => {
  window.ownerConfirmationRequired = ownerConfirmationRequired
  window.calls = []
  window.pairStatus = 'idle'
  window.paired = []
  window.policies = {}
  window.folders = {}
  window.origins = {}
  window.existingSessions = {}
  window.requests = []
  window.remedies = []
  window.syncStates = {}
  window.audiences = {}
  window.enabled = false
  window.autoRestart = true
  window.updateStatus = { format: 1, installedVersion: '1.0.0', sourceCommit: 'a'.repeat(40),
    automatic: true, channel: 'stable', phase: 'idle', canInstall: true, notify: false }
  window.chosen = ['/Users/person/Notes']
  const teamNames = ['Platform', 'Research', 'Sales']
  // The person enters the code in Nessie: the claim alone pairs, and the host starts the daemon.
  window.claimInNessie = () => {
    window.pairStatus = 'paired'
    const executorId = `team-${window.paired.length}`
    window.paired.push({ executorId, daemonStatus: 'running', paused: false, pendingProgramRequests: 0 })
    window.policies[executorId] = { mode: 'allowlist', allowlist: [], denylist: [],
      trusted: { unlikeotherai: true, claudeCode: true, codex: true, t3Code: true } }
    window.folders[executorId] = [{ name: 'nessie', path: '/Users/person/Nessie' }, { name: 'shared', path: '/Users/Shared' }]
    window.origins[executorId] = []
    window.audiences[executorId] = { agents: [{ id: 'a1', name: 'Jev' }], everyoneInTeam: false,
      people: [{ name: 'Ondrej', isOwner: true }], peopleCount: 1, projects: [], observedAt: new Date().toISOString() }
    return executorId
  }
  const view = () => ({ kind: 'reachable', executors: window.paired.map((row) => ({ ...row })) })
  const describe = (id) => ({
    existingClaudeChannelConfiguration: { mcpServers: { nessie: {
      command: 'node', args: ['nessie-executor.cjs', 'serve-existing-claude-channel', '--state-dir', 'pairing-1'],
    } } },
    existingCodingSessionsEnabled: window.existingSessions[id] !== false,
    executorId: id, apiBaseUrl: 'https://api.nessie.works', commandPolicy: window.policies[id],
    paused: window.paired.find((row) => row.executorId === id)?.paused ?? false,
    pendingProgramRequests: window.paired.find((row) => row.executorId === id)?.pendingProgramRequests ?? 0,
    programDefaults: [{ key: 'unlikeotherai', name: 'Apps from UnlikeOtherAI' }, { key: 'claudeCode', name: 'Claude Code' },
      { key: 'codex', name: 'Codex' }, { key: 't3Code', name: 'T3 Code' }],
    mcpPolicy: { mode: 'installed', disabled: [] },
    localApps: [{ name: 'kelpie', source: 'unlikeotherai', enabled: true, installed: true }],
    policy: { operations: ['file.read'], permittedPrograms: [], revision: 1 },
    reach: { folders: window.folders[id], allowedOrigins: window.origins[id] ?? [] },
    sandbox: { browserConfigured: false },
  })
  const invoke = async (command, args = {}) => {
    window.calls.push({ command, args })
    if (command === 'executor_update_setup') {
      if (window.updateSetupDenied) throw new Error('update.coordinator_unavailable')
      window.updateStatus = { ...window.updateStatus, phase: 'idle', canInstall: true, code: undefined }
      return { ...window.updateStatus }
    }
    if (command === 'executor_update_control') {
      if (window.updateUnavailable) throw new Error('update.coordinator_unavailable')
      const request = args.request
      if (request.operation === 'automatic') window.updateStatus.automatic = request.enabled
      if (request.operation === 'remind') window.updateStatus.notify = false
      if (request.operation === 'install') window.updateStatus = { ...window.updateStatus,
        targetVersion: window.updateStatus.availableVersion, phase: 'downloading', notify: false }
      return { ...window.updateStatus }
    }
    const id = args.executorId
    if (command === 'executor_sync_status') {
      if (window.syncHost) return window.syncHost(command, args)
      return window.syncStates[id] ?? { executorId: id, enabled: false, paused: false, state: 'off', counts: {}, conflicts: [], heldDeletes: null }
    }
    if (window.syncHost && (command.startsWith('executor_sync_') || command === 'executor_open_path')) return window.syncHost(command, args)
    if (command === 'executor_personal_chatgpt') {
      if (window.chatgptOffline) throw new Error('offline')
      const operation = args.operation
      window.chatgptProfile ??= { profileId: 'b83e9273-6e74-4a75-bada-9c3d5b80b493',
        phase: 'disconnected', planEnabled: false, reason: null, operationId: null, backgroundConsentRevision: null }
      window.chatgptProfiles ??= [window.chatgptProfile]
      if (operation.newProfileId && !window.chatgptProfiles.some(p => p.profileId === operation.newProfileId)) {
        window.chatgptProfiles.push({ ...window.chatgptProfile, profileId: operation.newProfileId,
          label: operation.label, phase: 'disconnected', planEnabled: false, backgroundConsentRevision: null })
      }
      const profile = window.chatgptProfiles.find(p => p.profileId === (operation.newProfileId ?? operation.profileId))
        ?? window.chatgptProfile
      if (operation.operation === 'rename') profile.label = operation.label
      if (operation.operation === 'start') { profile.phase = 'ready'; profile.planEnabled = true }
      if (operation.operation === 'background-consent') {
        if (operation.expectedRevision !== profile.backgroundConsentRevision) throw new Error('stale permission')
        profile.backgroundConsentRevision = operation.enabled ? (window.backgroundRevision = (window.backgroundRevision ?? 0) + 1) : null
      }
      if (['disconnect', 'cancel'].includes(operation.operation)) {
        profile.phase = 'disconnected'; profile.planEnabled = false; profile.backgroundConsentRevision = null
      }
      return { version: 1, profiles: window.chatgptProfiles.map(profile => ({ ...profile })), reason: null,
        restriction: 'unisolated_terminal_coding_and_custom_stdio_blocked' }
    }
    if (command === 'executor_inference_connections') {
      if (window.endpointOffline) throw new Error('offline')
      window.endpoints ??= []
      const operation = args.operation
      if (operation.operation === 'save') {
        window.endpoints = window.endpoints.filter(endpoint => endpoint.id !== operation.id)
        window.endpoints.push({ id: operation.id, name: operation.name, baseUrl: operation.baseUrl,
          scope: operation.scope, hasApiKey: Boolean(operation.apiKey), status: 'online', models: ['qwen'] })
      }
      if (operation.operation === 'remove') window.endpoints = window.endpoints.filter(endpoint => endpoint.id !== operation.id)
      return { endpoints: window.endpoints.map(endpoint => ({ ...endpoint })) }
    }
    if (command === 'executor_view') return view()
    if (command === 'executor_set_paused') {
      if (window.failPause) throw new Error(window.failPause)
      for (const row of window.paired) if (id === null || id === undefined || row.executorId === id) row.paused = args.paused
      return view()
    }
    if (command === 'executor_set_running') {
      for (const row of window.paired) row.daemonStatus = args.running ? 'running' : 'stopped'
      return view()
    }
    if (command === 'executor_apply_remedy') {
      window.remedies.push({ executorId: id, remedy: args.remedy })
      const row = window.paired.find((entry) => entry.executorId === id)
      delete row.failure
      row.daemonStatus = 'running'
      return view()
    }
    if (command === 'executor_reconnect') {
      window.paired.find((row) => row.executorId === id).daemonStatus = 'running'
      return view()
    }
    if (command === 'executor_audience') {
      if (window.audienceOffline) throw new Error('offline')
      return window.audiences[id]
    }
    if (command === 'executor_program_requests') return window.requests.filter((request) => !id || request.executorId === id)
    if (command === 'executor_answer_program_request') {
      const request = window.requests.find((entry) => entry.id === args.id)
      window.answers = (window.answers ?? []).concat([{ id: args.id, answer: args.answer }])
      window.requests = window.requests.filter((entry) => entry.id !== args.id)
      const row = window.paired.find((entry) => entry.executorId === id)
      row.pendingProgramRequests = Math.max(0, row.pendingProgramRequests - 1)
      if (args.answer === 'always' && request) window.policies[id].allowlist.push(`${request.program} *`)
      return window.requests.slice()
    }
    if (command === 'executor_open_logs') return null
    if (command === 'executor_remove') {
      window.paired = window.paired.filter((row) => row.executorId !== id)
      return { signedOff: !window.removeUntold }
    }
    if (command === 'executor_choose_folder') return window.chosen.shift() ?? null
    if (command === 'executor_pairing_start') {
      if (window.pairingFailure) throw new Error(window.pairingFailure)
      if (!args.apiBaseUrl.startsWith('https://')) throw new Error('The server address must start with https://.')
      window.pairServer = args.apiBaseUrl
      window.pairStatus = 'waiting'
    }
    if (command === 'executor_pairing_cancel') window.pairStatus = 'cancelled'
    if (command === 'executor_pairing_status' && id && window.ownerConfirmationRequired) {
      throw new Error('PAIRING_OWNER_CONFIRMATION_REQUIRED')
    }
    if (command.startsWith('executor_pairing_')) {
      const executorId = id ?? `team-${window.paired.length - 1}`
      const index = Number(executorId.split('-')[1])
      return {
        status: id ? 'paired' : window.pairStatus, code: '01234567',
        expiresAt: window.expiresAt ?? new Date(Date.now() + 590000).toISOString(),
        machineName: 'My computer', executorId,
        organizationName: 'UnlikeOtherAI', teamName: teamNames[index] ?? `Team ${index}`,
        apiBaseUrl: window.pairServer ?? 'https://api.nessie.works',
      }
    }
    if (command === 'executor_configure' && window.failConfigure) throw new Error(window.failConfigure)
    if (command === 'executor_configure') {
      window.configured = (window.configured ?? []).concat([{ id, input: args.configurationInput }])
      const input = args.configurationInput
      window.policies[id] = input.commandPolicy ?? window.policies[id]
      if (input.workspaceFolders) window.folders[id] = input.workspaceFolders
      if (input.allowedOrigins) window.origins[id] = input.allowedOrigins
      if (input.existingCodingSessionsEnabled !== undefined) window.existingSessions[id] = input.existingCodingSessionsEnabled
    }
    if (['executor_describe', 'executor_console_describe', 'executor_configure'].includes(command)) {
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
  if (paired) window.claimInNessie()
}, { host, paired, ownerConfirmationRequired })
}

/** Every file `index.html` loads, shell and team tabs alike. */
export const consoleFiles = {
  shell: ['index.html', 'style.css', 'native.js', 'i18n.js', 'main.js', 'errors-words.js', 'errors.js', 'teams-words.js', 'teams.js',
    'overview-words.js', 'overview-summary.js', 'overview.js', 'pairing-words.js', 'pairing.js', 'updates-words.js', 'updates.js',
    'settings-words.js', 'settings.js'],
  teamTabs: ['access.js', 'access-words.js', 'documents.js', 'documents-words.js', 'ai.js', 'ai-words.js', 'chatgpt.js', 'chatgpt-words.js',
    'inference-endpoints.js', 'team-drafts.js', 'autosave.js'],
}
