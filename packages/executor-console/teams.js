// Which teams use this computer, what each is called, which one is selected,
// and the durable Pause/Resume and Disconnect actions. Everything a tab knows
// about a team comes through `nc.team`.
(() => {
  const nc = window.nc
  const { invoke, byId, t } = nc
  let executors = []
  let current = null
  const names = new Map()
  const lookupFailed = new Set()
  const ownerConfirmationRequired = new Set()
  const describes = new Map()
  const selectionListeners = new Set()
  const listListeners = new Set()
  let rendered = ''
  let disconnecting = null

  const apiBaseUrl = (executorId) => names.get(executorId)?.apiBaseUrl ?? null
  const host = (executorId) => {
    try { return apiBaseUrl(executorId) ? new URL(apiBaseUrl(executorId)).host : null } catch { return null }
  }
  const ownLabel = (executorId) => {
    const name = names.get(executorId)
    return [name?.teamName, name?.organizationName].filter(Boolean).join(' · ') || null
  }
  // On Windows a team's ChatGPT plans live on a second, service-owned connection
  // to the same team (`chatgptConnectionId` on the team's own row). It is the
  // team's plan connection, never a second team: it stays out of the team
  // dropdown and the team count, and its label says what it is.
  const planOwner = (executorId) => executors.find((team) => team.chatgptConnectionId === executorId) ?? null
  const isPlanConnection = (executorId) => planOwner(executorId) !== null
  /** The team a connection belongs to: itself, or the team whose plan connection it is. */
  const teamOf = (executorId) => planOwner(executorId)?.executorId ?? executorId
  const teams = () => executors.filter((team) => !isPlanConnection(team.executorId))
  /** `{teamName} · {organizationName}`; two equal labels get the server host; an unknown name says so. Never an id. */
  const label = (executorId) => {
    const owner = planOwner(executorId)
    if (owner) return t('teams.planConnection', { team: label(owner.executorId) })
    const own = ownLabel(executorId)
    if (!own) return t('shell.teamNameUnknown')
    const shared = teams().some((team) => team.executorId !== executorId && ownLabel(team.executorId) === own)
    return shared && host(executorId) ? `${own} (${host(executorId)})` : own
  }
  /** The connection holding a team's ChatGPT plans: a service row itself, its plan connection, or null while none exists. */
  const planConnectionOf = (executorId) => {
    const team = executors.find((row) => row.executorId === executorId)
    if (!team) return null
    if (team.connection !== 'user') return executorId
    return team.chatgptConnectionId ?? null
  }
  /** One of `working`, `paused`, `needs_you`, `not_connected`. */
  const status = (team) => {
    if (team.paused) return 'paused'
    if (team.pendingProgramRequests > 0) return 'needs_you'
    if (team.failure) return 'not_connected'
    return ['running', 'starting', 'running elsewhere'].includes(team.daemonStatus) ? 'working' : 'not_connected'
  }

  // A name lookup asks Nessie and can take seconds; one pass runs at a time
  // and a refused name waits a minute, so the refresh never queues lookups.
  const NAME_RETRY_MS = 60_000
  const nameRetryAt = new Map()
  let namesInFlight = false
  const lookUpNames = async (list) => {
    if (namesInFlight) return
    namesInFlight = true
    try {
      for (const { executorId } of list) {
        if (names.has(executorId) || (nameRetryAt.get(executorId) ?? 0) > Date.now()) continue
        try {
          names.set(executorId, await invoke('executor_pairing_status', { executorId }))
          lookupFailed.delete(executorId)
          ownerConfirmationRequired.delete(executorId)
          nameRetryAt.delete(executorId)
        } catch (error) {
          if (String(error?.message ?? error).includes('PAIRING_OWNER_CONFIRMATION_REQUIRED')) ownerConfirmationRequired.add(executorId)
          lookupFailed.add(executorId)
          nameRetryAt.set(executorId, Date.now() + NAME_RETRY_MS)
        }
      }
    } finally { namesInFlight = false }
  }

  const notifySelection = () => { for (const listener of selectionListeners) listener(current) }
  const apply = (view) => {
    if (view.kind !== 'reachable') throw new Error(view.reason)
    executors = view.executors
    if (!teams().some((team) => team.executorId === current)) {
      current = teams()[0]?.executorId ?? null
      if (current) describes.delete(current)
      notifySelection()
    }
    const signature = JSON.stringify([executors,
      executors.map((team) => [label(team.executorId), ownerConfirmationRequired.has(team.executorId)])])
    if (signature === rendered) return
    rendered = signature
    for (const listener of listListeners) listener(executors)
  }
  const refresh = async () => {
    const view = await invoke('executor_view')
    if (view.kind !== 'reachable') throw new Error(view.reason)
    await lookUpNames(view.executors)
    apply(view)
  }

  /** Selecting a team reads it afresh: a program request answered or a live-applied revision may have changed it. */
  const select = (executorId) => {
    if (executorId === current) return
    current = executorId
    describes.delete(executorId)
    notifySelection()
  }
  /**
   * The team's `describe`, loaded once per selection and kept until a save
   * `remember`s a newer one or `fresh` asks again. A read that fails is not
   * kept, so the next call asks again.
   */
  const describe = (executorId = current, { fresh = false } = {}) => {
    if (!executorId) return Promise.reject(new Error(t('shell.noTeam')))
    if (fresh || !describes.has(executorId)) {
      const loading = invoke('executor_describe', { executorId }).catch((error) => {
        if (describes.get(executorId) === loading) describes.delete(executorId)
        throw error
      })
      describes.set(executorId, loading)
    }
    return describes.get(executorId)
  }
  const remember = (executorId, description) => { describes.set(executorId, Promise.resolve(description)) }

  /** Pause or resume one team (`executorId`) or every team (`null`). The daemon enforces it; this only asks. */
  const setPaused = async (executorId, paused) => {
    apply(await invoke('executor_set_paused', { executorId, paused }))
    if (!paused) { nc.footer.note(t('teams.resumedNote')); return }
    nc.footer.note(t(executorId ? 'teams.pausedNote' : 'teams.pausedAllNote'))
  }
  const applyRemedy = async (executorId, remedy) => { apply(await invoke('executor_apply_remedy', { executorId, remedy })) }

  // Disconnect asks first, in a dialog that cannot be dismissed while the removal runs.
  const openDisconnect = (executorId) => {
    disconnecting = executorId
    byId('disconnect-title').textContent = t('teams.disconnectTitle', { team: label(executorId) })
    byId('disconnect-body').textContent = t('teams.disconnectBody')
    byId('disconnect-confirm').textContent = t('teams.disconnectConfirm')
    nc.dialogs.open('disconnect-dialog')
    byId('disconnect-cancel').focus()
  }
  byId('disconnect-cancel').textContent = t('shell.cancel')
  byId('disconnect-dialog').addEventListener('cancel', (event) => { if (byId('disconnect-confirm').disabled) event.preventDefault() })
  byId('disconnect-confirm').onclick = () => nc.attempt(async () => {
    const executorId = disconnecting
    const team = label(executorId)
    const [confirm, cancel] = [byId('disconnect-confirm'), byId('disconnect-cancel')]
    confirm.disabled = cancel.disabled = true
    confirm.textContent = t('teams.disconnecting')
    try {
      const result = await invoke('executor_remove', { executorId })
      byId('disconnect-dialog').close()
      names.delete(executorId)
      describes.delete(executorId)
      nc.footer.forget(`${executorId}:`)
      await refresh()
      nc.view.show('overview')
      byId('tab-overview').querySelector('[data-action=connect]')?.focus()
      if (result?.signedOff) nc.footer.note(t('teams.disconnected', { team }))
      else nc.reportError(new Error(t('teams.disconnectedUntold', { team })))
    } finally {
      confirm.disabled = cancel.disabled = false
      confirm.textContent = t('teams.disconnectConfirm')
    }
  })

  nc.team = {
    current: () => current,
    select,
    label,
    host,
    apiBaseUrl,
    list: () => executors,
    teams,
    isPlanConnection,
    teamOf,
    planConnectionOf,
    get: (executorId) => executors.find((team) => team.executorId === executorId) ?? null,
    status,
    statusWord: (team) => t(`teams.${{ working: 'working', paused: 'paused', needs_you: 'needsYou', not_connected: 'notConnected' }[status(team)]}`),
    nameUnknown: (executorId) => !names.has(executorId),
    ownerConfirmationRequired: (executorId) => ownerConfirmationRequired.has(executorId),
    describe,
    remember,
    refresh,
    setPaused,
    applyRemedy,
    disconnect: openDisconnect,
    onChange: (listener) => { selectionListeners.add(listener); return () => selectionListeners.delete(listener) },
    onListChange: (listener) => { listListeners.add(listener); return () => listListeners.delete(listener) },
  }
})()
