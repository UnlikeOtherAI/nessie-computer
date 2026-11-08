// The AI tab: Claude Code and Codex on this computer (ai-local.js), then the
// chosen team's ChatGPT plans and model servers.
window.aiTab = (() => {
  const nc = window.nc
  const t = (key, vars) => nc.t(`ai.${key}`, vars)
  const tab = nc.byId('tab-ai')
  let request = 0
  let plans = []
  let endpoints = []
  tab.innerHTML = `
    <div class="section-heading"><div class="label-row"><h3 id="ai-plans-title"></h3></div><button type="button" id="ai-add-chatgpt"></button></div>
    <div id="ai-chatgpt-list"></div>
    <hr>
    <div class="section-heading"><div class="label-row"><h3 id="ai-endpoints-title"></h3></div><button type="button" id="ai-add-endpoint"></button></div>
    <div id="ai-endpoint-list"></div>
    <p id="ai-error" class="field-error" role="alert" hidden></p>
    <button type="button" id="ai-refresh"></button>`
  // "On this computer" comes first, above ChatGPT plans (contract §12).
  tab.prepend(window.aiLocal.section, document.createElement('hr'))
  // What a plan or a server is sits behind "?" beside each heading; on Windows the
  // plans' "?" also says how the first plan connects.
  const plansHelp = nc.help('')
  plansHelp.id = 'ai-plans-hint'
  nc.byId('ai-plans-title').after(plansHelp)
  const serversHelp = nc.help('')
  serversHelp.id = 'ai-endpoints-hint'
  nc.byId('ai-endpoints-title').after(serversHelp)
  const row = (name, detail, id, manage) => {
    const node = document.createElement('div')
    node.className = 'list-row'
    const label = document.createElement('div')
    label.className = 'list-name'
    label.textContent = name
    const status = document.createElement('small')
    status.textContent = detail
    label.append(status)
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = t('manage')
    button.setAttribute('aria-label', `${t('manage')} · ${name}`)
    button.dataset.key = id
    button.onclick = () => nc.attempt(manage, { target: button })
    node.append(label, button)
    return node
  }
  const renderWords = () => {
    const executorId = nc.team.current()
    const team = executorId ? nc.team.label(executorId) : ''
    plansHelp.set([t('plansHint', { team }), executorId && !planConnection() ? t('connection.needed', { team }) : null].filter(Boolean).join(' '))
    serversHelp.set(t('serversHint'))
    for (const [id, key] of [['ai-plans-title', 'plans'], ['ai-add-chatgpt', 'addPlan'], ['ai-endpoints-title', 'servers'],
      ['ai-add-endpoint', 'addServer'], ['ai-refresh', 'refresh']]) nc.byId(id).textContent = t(key)
    tab.lang = document.documentElement.lang
  }
  /** The name a plan shows: its own, or "ChatGPT plan N" by its place in the list. */
  const planName = (profile, index) => profile.label ?? t('planName', { n: index + 1 })
  /**
   * The connection that holds the team's plans. On macOS that is the team
   * itself; on Windows it is the service connection, which a team this app
   * runs gets through the one-time flow in ai-connection.js.
   */
  const planConnection = () => nc.team.planConnectionOf(nc.team.current())

  const load = async () => {
    const asked = ++request
    const executorId = nc.team.current()
    renderWords()
    plans = []
    endpoints = []
    for (const id of ['ai-chatgpt-list', 'ai-endpoint-list']) nc.byId(id).textContent = t('loading')
    nc.byId('ai-error').hidden = true
    if (!executorId) return
    void window.aiLocal.load()
    const plansOn = planConnection()
    const results = await Promise.allSettled([
      plansOn ? nc.invoke('executor_personal_chatgpt', { executorId: plansOn, operation: { operation: 'status' } })
        : Promise.resolve({ profiles: [], reason: null }),
      nc.invoke('executor_inference_connections', { executorId, operation: { operation: 'status' } }),
    ])
    if (asked !== request || executorId !== nc.team.current()) return
    const [accounts, servers] = results
    const planList = nc.byId('ai-chatgpt-list')
    planList.replaceChildren()
    if (accounts.status === 'fulfilled') {
      plans = accounts.value.profiles
      for (const [index, profile] of plans.entries()) {
        planList.append(row(planName(profile, index), nc.t(`chatgpt.phases.${profile.phase}`), profile.profileId,
          () => window.chatgptDialog.open(plansOn, profile.profileId)))
      }
      if (!plans.length) planList.textContent = accounts.value.reason
        ? nc.t(`chatgpt.unavailable.${accounts.value.reason in window.chatgptDialog.reasons ? accounts.value.reason : 'other'}`) : t('emptyPlans')
    } else planList.textContent = nc.t('chatgpt.failed')
    const endpointList = nc.byId('ai-endpoint-list')
    endpointList.replaceChildren()
    if (servers.status === 'fulfilled') {
      endpoints = servers.value.endpoints
      for (const endpoint of endpoints) {
        endpointList.append(row(endpoint.name,
          `${t(endpoint.status)} · ${endpoint.baseUrl} · ${endpoint.models.join(', ') || t('noModels')}`,
          endpoint.id, () => window.inferenceEndpoints.open(endpoint)))
      }
      if (!endpoints.length) endpointList.textContent = t('emptyServers')
    } else endpointList.textContent = t('failed')
  }
  const shown = () => nc.view.current() === 'ai' && Boolean(nc.team.current())
  const refresh = () => { if (shown()) nc.attempt(load) }
  /** On a team this Windows app runs, the first plan first connects the service; then it is named and signed in. */
  const addPlan = async () => {
    const executorId = nc.team.current()
    let plansOn = planConnection()
    if (!plansOn) {
      plansOn = await window.aiConnection.connect(executorId)
      if (!plansOn || executorId !== nc.team.current()) return
      await load()
    }
    if (executorId === nc.team.current()) await window.chatgptDialog.open(plansOn, null, plans.length + 1)
  }
  nc.byId('ai-add-chatgpt').onclick = () => nc.attempt(addPlan, { target: nc.byId('ai-add-chatgpt') })
  nc.byId('ai-add-endpoint').onclick = () => window.inferenceEndpoints.open(null)
  nc.byId('ai-refresh').onclick = () => nc.attempt(load)
  nc.view.onChange(refresh)
  nc.team.onChange(refresh)
  document.addEventListener('DOMContentLoaded', refresh)
  return { load, planName }
})()
