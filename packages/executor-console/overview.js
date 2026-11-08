// Overview: the status sentence and Pause all in the header, the Needs you
// list, one card per team, Add this computer, and the card shown after a team
// connects. Computer-wide, so no team row.
(() => {
  const nc = window.nc
  const { byId, invoke, t, attempt } = nc
  let requests = []
  const syncStates = new Map()
  const summaries = new Map()
  const audiences = new Map()
  let connectedId = null
  let needsAt = 0

  // ---- what needs the owner, newest knowledge first
  const needItems = () => {
    const items = []
    for (const request of requests) {
      const team = nc.team.label(request.executorId)
      const text = request.agentName ? t('overview.request', { agent: request.agentName, program: request.program })
        : t('overview.requestNoAgent', { program: request.program })
      items.push({ kind: 'request', request, text, short: text, team })
    }
    for (const team of nc.team.list()) {
      if (team.failure) {
        const text = t('overview.notConnected', { team: nc.team.label(team.executorId) })
        items.push({ kind: 'failure', team, text, short: text })
      }
      if (nc.team.isPlanConnection(team.executorId)) continue
      const reason = nc.summary.syncAttention(syncStates.get(team.executorId))
      if (reason) {
        const text = t('overview.documentsNeedYou', { team: nc.team.label(team.executorId), reason: t(`overview.reasons.${reason}`) })
        items.push({ kind: 'sync', team, text, short: text })
      }
    }
    return items
  }

  // ---- header
  const renderHeader = () => {
    const teams = nc.team.teams()
    const needs = needItems()
    const paused = teams.filter((team) => team.paused).length
    const working = teams.filter((team) => nc.team.status(team) === 'working').length
    byId('status-sentence').textContent = !teams.length ? t('shell.statusNone')
      : needs.length ? t('shell.statusNeedsYou', { what: needs[0].short })
        : paused === teams.length ? t('shell.statusPaused')
          : !working ? t('shell.statusNotConnected')
            : [t('shell.statusWorking', { count: working }), paused ? t('shell.statusPausedCount', { count: paused }) : null].filter(Boolean).join(' · ')
    const button = byId('pause-all')
    button.hidden = !teams.length
    const allPaused = Boolean(teams.length) && paused === teams.length
    button.textContent = t(allPaused ? 'shell.resumeAll' : 'shell.pauseAll')
    button.onclick = () => attempt(async () => {
      button.disabled = true
      try { await nc.team.setPaused(null, !allPaused) } finally { button.disabled = false }
    }, { target: button })
  }

  // ---- Needs you
  const answerRequest = (request, answer) => attempt(async () => {
    requests = await invoke('executor_answer_program_request', { executorId: request.executorId, id: request.id, answer })
    await nc.team.refresh()
    render()
  })
  const needRow = (item) => {
    const row = document.createElement('li')
    row.className = `need need-${item.kind}`
    const text = document.createElement('p')
    text.textContent = item.text
    row.append(text)
    if (item.kind === 'request') {
      row.dataset.request = item.request.id
      const where = document.createElement('small')
      where.textContent = [t('overview.inTeam', { team: item.team }), item.request.args?.length ? item.request.args.join(' ') : null].filter(Boolean).join(' · ')
      text.append(' ', where)
      const actions = document.createElement('div')
      actions.className = 'actions start'
      for (const [answer, label, cls] of [['once', t('overview.allowOnce'), 'primary'], ['always', t('overview.allowAlways', { program: item.request.program }), ''], ['deny', t('overview.deny'), '']]) {
        const button = document.createElement('button')
        button.textContent = label
        if (cls) button.className = cls
        button.dataset.key = `${item.request.id}:${answer}`
        button.onclick = () => answerRequest(item.request, answer)
        actions.append(button)
      }
      row.append(actions)
    }
    if (item.kind === 'failure') {
      const block = document.createElement('div')
      nc.failure.render(block, item.team.failure, {
        executorId: item.team.executorId,
        onRemedy: (remedy) => nc.team.applyRemedy(item.team.executorId, remedy).then(render),
      })
      row.append(block)
    }
    if (item.kind === 'sync') {
      const button = document.createElement('button')
      button.textContent = t('overview.openDocuments')
      button.dataset.key = `sync:${item.team.executorId}`
      button.onclick = () => attempt(async () => { await nc.team.select(item.team.executorId); nc.view.show('documents') })
      row.append(button)
    }
    return row
  }
  const renderNeeds = () => nc.keepFocus(byId('needs-you-list'), () => {
    const items = needItems()
    byId('overview-needs').hidden = !items.length
    byId('needs-you-list').replaceChildren(...items.map(needRow))
  })

  // ---- team cards
  const fill = (executorId, cls, text) => {
    for (const node of byId('tab-overview').querySelectorAll(`[data-team="${CSS.escape(executorId)}"] .${cls}`)) node.textContent = text
    if (cls === 'team-summary' && executorId === connectedId) renderConnected()
  }
  const loadSummary = (executorId, fresh) => {
    summaries.set(executorId, null)
    nc.team.describe(executorId, { fresh }).then((description) => {
      summaries.set(executorId, nc.summary.access(description))
      fill(executorId, 'team-summary', summaries.get(executorId))
    }).catch(() => { summaries.set(executorId, t('overview.summaryFailed')); fill(executorId, 'team-summary', summaries.get(executorId)) })
  }
  const loadAudience = (executorId) => {
    audiences.set(executorId, null)
    invoke('executor_audience', { executorId }).then((answer) => {
      audiences.set(executorId, nc.summary.audience(answer))
      fill(executorId, 'team-audience-text', audiences.get(executorId))
    }).catch(() => { audiences.set(executorId, t('overview.audienceFailed')); fill(executorId, 'team-audience-text', audiences.get(executorId)) })
  }
  const reload = (fresh) => {
    for (const team of nc.team.teams()) {
      if (fresh || !summaries.has(team.executorId)) loadSummary(team.executorId, fresh)
      if (fresh || !audiences.has(team.executorId)) loadAudience(team.executorId)
    }
  }
  const changeAccess = (executorId) => attempt(async () => { await nc.team.select(executorId); nc.view.show('access') })
  const teamCard = (team) => {
    const card = document.createElement('article')
    card.className = 'team-card'
    card.dataset.team = team.executorId
    const head = document.createElement('div')
    head.className = 'team-card-head'
    const name = document.createElement('h3')
    name.textContent = nc.team.label(team.executorId)
    const status = document.createElement('span')
    status.className = 'status-word'
    status.dataset.tone = nc.team.status(team)
    status.textContent = nc.team.statusWord(team)
    head.append(name, status)
    const summary = document.createElement('p')
    summary.className = 'team-summary'
    summary.textContent = summaries.get(team.executorId) ?? t('overview.summaryLoading')
    // On Windows the team's ChatGPT plans run on a second, service-owned connection; its state sits on the team's card.
    const planLine = document.createElement('p')
    planLine.className = 'team-plan'
    planLine.hidden = !team.chatgptConnectionId
    if (team.chatgptConnectionId) {
      const plan = nc.team.get(team.chatgptConnectionId)
      planLine.textContent = t('overview.planConnection', { status: plan ? nc.team.statusWord(plan) : t('teams.notConnected') })
    }
    const audience = document.createElement('p')
    audience.className = 'team-audience'
    const audienceLabel = document.createElement('span')
    audienceLabel.className = 'label-inline'
    audienceLabel.textContent = `${t('overview.whoCanSend')}: `
    const audienceText = document.createElement('span')
    audienceText.className = 'team-audience-text'
    audienceText.textContent = audiences.get(team.executorId) ?? t('overview.audienceLoading')
    audience.append(audienceLabel, audienceText)
    card.append(head, summary, planLine, audience)
    if (nc.team.ownerConfirmationRequired(team.executorId)) {
      const restore = document.createElement('p')
      restore.className = 'hint'
      restore.textContent = t('teams.restoreNames')
      card.append(restore)
    }
    const actions = document.createElement('div')
    actions.className = 'actions start'
    const access = document.createElement('button')
    access.textContent = t('overview.changeAccess')
    access.dataset.key = `${team.executorId}:access`
    access.onclick = () => changeAccess(team.executorId)
    const pause = document.createElement('button')
    pause.textContent = t(team.paused ? 'teams.resume' : 'teams.pause')
    pause.dataset.key = `${team.executorId}:pause`
    pause.onclick = () => attempt(async () => {
      pause.disabled = true
      pause.textContent = t(team.paused ? 'teams.resuming' : 'teams.pausing')
      try { await nc.team.setPaused(team.executorId, !team.paused) } finally { render() }
    }, { target: pause })
    const disconnect = document.createElement('button')
    disconnect.textContent = t('teams.disconnect')
    disconnect.dataset.key = `${team.executorId}:disconnect`
    disconnect.setAttribute('aria-label', `${t('teams.disconnect')} ${nc.team.label(team.executorId)}`)
    disconnect.onclick = () => nc.team.disconnect(team.executorId)
    actions.append(access, pause, disconnect)
    card.append(actions)
    return card
  }
  const renderTeams = () => nc.keepFocus(byId('team-cards'), () => {
    const teams = nc.team.teams()
    byId('overview-welcome').hidden = Boolean(teams.length)
    byId('overview-teams').hidden = !teams.length
    byId('team-cards').replaceChildren(...teams.map(teamCard))
  }, () => byId('overview-connect'))

  // ---- the card after a team connects
  const renderConnected = () => {
    const card = byId('overview-connected')
    const team = connectedId ? nc.team.get(connectedId) : null
    card.hidden = !team
    if (!team) return
    card.dataset.team = team.executorId
    byId('connected-title').textContent = t('overview.connectedTitle', { team: nc.team.label(team.executorId) })
    byId('connected-body').textContent = t('overview.connectedBody', { summary: summaries.get(team.executorId) ?? t('overview.summaryLoading') })
    byId('connected-access').onclick = () => changeAccess(team.executorId)
    byId('connected-disconnect').onclick = () => nc.team.disconnect(team.executorId)
  }
  byId('connected-done').onclick = () => { connectedId = null; renderConnected(); byId('overview-connect').focus() }

  const render = () => { renderHeader(); renderNeeds(); renderTeams(); renderConnected() }

  // Program requests and Documents attention are asked for while Overview is showing; failures ride the view.
  const loadNeeds = async () => {
    const teams = nc.team.teams()
    const [nextRequests, states] = await Promise.all([
      teams.some((team) => team.pendingProgramRequests > 0) ? invoke('executor_program_requests', {}) : Promise.resolve([]),
      Promise.all(teams.map((team) => invoke('executor_sync_status', { executorId: team.executorId }).then((state) => [team.executorId, state]).catch(() => null))),
    ])
    requests = Array.isArray(nextRequests) ? nextRequests : []
    syncStates.clear()
    for (const entry of states) if (entry) syncStates.set(entry[0], entry[1])
    needsAt = Date.now()
    render()
  }

  byId('overview-welcome-text').textContent = t('overview.welcome')
  byId('overview-welcome-connect').textContent = t('overview.addComputer')
  byId('overview-needs-title').textContent = t('overview.needsYou')
  byId('overview-teams-title').textContent = t('overview.teams')
  byId('overview-connect').textContent = t('overview.addComputer')
  byId('connected-access').textContent = t('overview.changeAccess')
  byId('connected-done').textContent = t('shell.done')
  byId('connected-unexpected').textContent = t('overview.unexpected')
  byId('connected-disconnect').textContent = t('teams.disconnectConfirm')
  for (const button of document.querySelectorAll('[data-action=connect]')) button.onclick = () => attempt(() => nc.pairing.open())

  nc.overview = {
    connected: (executorId) => { connectedId = executorId; loadSummary(executorId, true); render(); nc.view.show('overview') },
    render,
    refresh: () => { reload(true); return loadNeeds() },
  }
  // Registered now, not on DOMContentLoaded: a host that answers at once lists the teams before that event.
  nc.team.onListChange(() => { reload(false); render(); loadNeeds().catch(() => undefined) })
  nc.view.onChange((tab) => { if (tab === 'overview') { reload(true); loadNeeds().catch(() => undefined) } })
  window.addEventListener('DOMContentLoaded', () => {
    setInterval(() => {
      if (nc.view.current() !== 'overview' || Date.now() - needsAt < 4000) return
      loadNeeds().catch(() => undefined)
    }, 5000)
    render()
  })
})()
