// Needs you: a strip under the team dropdown, on every tab, shown only while
// something waits for the owner — a program request answered inline, a team
// that is not connected with its one remedy, stuck or refused updates, Documents waiting
// for a decision. Read every 5 s.
(() => {
  const nc = window.nc
  const { byId, invoke, t, attempt } = nc
  let requests = []
  const syncStates = new Map()
  const deciding = new Set()
  let loadGeneration = 0
  let reading = null
  let loadedAt = 0

  /** Documents attention worth a line here, or null. */
  const syncAttention = (state) => {
    if (!state?.enabled) return null
    if (['root_missing', 'disk_full', 'needs_reauthorization', 'waiting_for_confirmation'].includes(state.state)) return state.state
    if (state.heldDeletes) return 'held'
    if (state.conflicts?.length || state.counts?.openConflicts > 0 || state.counts?.errors > 0 || state.state === 'needs_attention') return 'needs_attention'
    return null
  }

  // ---- what needs the owner, most urgent first
  const items = () => {
    const list = []
    if (nc.updates?.waiting() && nc.view.current() !== 'settings') {
      list.push({ kind: 'connecting', text: t('updates.connecting') })
    }
    if (nc.updates?.stuck()) list.push({ kind: 'updates', text: t('updates.stuckNeed') })
    if (nc.updates?.approval()) list.push({ kind: 'updates-approval', text: t('updates.approval') })
    if (nc.updates?.refused()) list.push({ kind: 'updates-registration', text: nc.updates.cantStart() })
    for (const request of requests) list.push({ kind: 'request', request, team: nc.team.label(request.executorId),
      text: request.agentName ? t('needs.request', { agent: request.agentName, program: request.program }) : t('needs.requestNoAgent', { program: request.program }) })
    for (const team of nc.team.list()) {
      if (team.failure) list.push({ kind: 'failure', team, text: t('needs.notConnected', { team: nc.team.label(team.executorId) }) })
      if (nc.team.isPlanConnection(team.executorId)) continue
      const reason = syncAttention(syncStates.get(team.executorId))
      if (reason) list.push({ kind: 'sync', team, reason, text: t('needs.documents', { team: nc.team.label(team.executorId), reason: t(`needs.reasons.${reason}`) }) })
    }
    return list
  }

  const answerRequest = (request, answer) => attempt(async () => {
    requests = await invoke('executor_answer_program_request', { executorId: request.executorId, id: request.id, answer })
    await nc.team.refresh()
    render()
  })
  const button = (label, key, onclick, cls = '') => {
    const node = document.createElement('button')
    node.textContent = label
    if (cls) node.className = cls
    node.dataset.key = key
    node.onclick = onclick
    return node
  }
  const row = (item) => {
    const line = document.createElement('li')
    line.className = `need need-${item.kind}`
    const text = document.createElement('p')
    text.textContent = item.text
    line.append(text)
    const actions = document.createElement('div')
    actions.className = 'actions start'
    if (item.kind === 'request') {
      line.dataset.request = item.request.id
      const where = document.createElement('small')
      where.textContent = [t('needs.inTeam', { team: item.team }), item.request.args?.length ? item.request.args.join(' ') : null].filter(Boolean).join(' · ')
      text.append(' ', where)
      actions.append(
        button(t('needs.allowOnce'), `${item.request.id}:once`, () => answerRequest(item.request, 'once'), 'primary'),
        button(t('needs.allowAlways', { program: item.request.program }), `${item.request.id}:always`, () => answerRequest(item.request, 'always')),
        button(t('needs.deny'), `${item.request.id}:deny`, () => answerRequest(item.request, 'deny')),
      )
    }
    if (item.kind === 'failure') {
      const block = document.createElement('div')
      nc.failure.render(block, item.team.failure, { executorId: item.team.executorId,
        onRemedy: (remedy) => nc.team.applyRemedy(item.team.executorId, remedy).then(render) })
      line.append(block)
      return line
    }
    if (item.kind === 'updates') {
      const restart = button(t('updates.restart'), 'updates:restart', () => attempt(async () => { await nc.updates.restart(); render() }, { target: restart }), 'primary')
      actions.append(restart)
    }
    if (item.kind === 'updates-approval') {
      const open = button(t('updates.openLoginItems'), 'updates:approve', () => attempt(async () => { await nc.updates.approve(); render() }, { target: open }), 'primary')
      actions.append(open)
    }
    if (item.kind === 'updates-registration') {
      const retry = button(t('updates.tryAgain'), 'updates:retry', () => attempt(async () => { await nc.updates.retry(); render() }, { target: retry }), 'primary')
      actions.append(retry)
    }
    if (item.kind === 'sync') {
      const { executorId } = item.team
      const approval = ['waiting_for_confirmation', 'needs_reauthorization'].includes(item.reason)
      actions.append(button(t(approval ? 'shell.details' : 'needs.openDocuments'), `sync:${executorId}`,
        () => attempt(async () => { await nc.team.select(executorId); nc.view.show('documents') })))
      if (approval) {
        for (const decision of ['allow', 'decline']) {
          const action = button(t(`needs.${decision}`), `sync:${executorId}:${decision}`, () => attempt(async () => {
            if (deciding.has(executorId)) return
            deciding.add(executorId)
            render()
            try {
              await nc.documents.decide(executorId, item.reason, decision)
            } finally {
              deciding.delete(executorId)
              await load(true)
            }
          }), decision === 'allow' ? 'primary' : '')
          action.disabled = deciding.has(executorId)
          actions.append(action)
        }
      }
    }
    line.append(actions)
    return line
  }
  const render = () => nc.keepFocus(byId('needs-you-list'), () => {
    const list = items()
    byId('needs-you-list').hidden = !list.length
    byId('needs-you-list').replaceChildren(...list.map(row))
  })

  // Program requests are asked for only while a team reports one; Documents attention per team.
  const read = async () => {
    const generation = ++loadGeneration
    const teams = nc.team.teams()
    const [next, states] = await Promise.all([
      teams.some((team) => team.pendingProgramRequests > 0) ? invoke('executor_program_requests', {}) : Promise.resolve([]),
      Promise.all(teams.map((team) => invoke('executor_sync_status', { executorId: team.executorId }).then((state) => [team.executorId, state]).catch(() => null))),
    ])
    if (generation !== loadGeneration) return
    requests = Array.isArray(next) ? next : []
    syncStates.clear()
    for (const entry of states) if (entry) syncStates.set(entry[0], entry[1])
    loadedAt = Date.now()
    render()
  }

  // Polls can take longer than their interval. Only an explicit refresh after
  // a decision supersedes the current read.
  const load = (fresh = false) => {
    if (reading && !fresh) return reading
    const current = read().finally(() => { if (reading === current) reading = null })
    reading = current
    return current
  }

  nc.needs = { render, refresh: () => load(true), syncAttention }
  // Registered now, not on DOMContentLoaded: a host that answers at once lists the teams before that event.
  nc.view.onChange(render)
  nc.team.onListChange(() => { render(); load().catch(() => undefined) })
  window.addEventListener('DOMContentLoaded', () => {
    // Updates load after this file; their status changes the strip.
    nc.updates?.onStatus(() => render())
    setInterval(() => { if (Date.now() - loadedAt >= 4000) load().catch(() => undefined) }, 5000)
    render()
  })
})()
