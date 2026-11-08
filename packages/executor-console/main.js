// The window itself: tabs, the team row, errors beside their control, the
// footer line, dialogs and the events the native host sends. Teams, Overview,
// Connect a team, Settings and the team tabs each build on `window.nc`
// (documented in README.md).
(() => {
  const nc = window.nc
  const { invoke, listen } = window.executorNative
  const byId = (id) => document.getElementById(id)
  const t = nc.t
  const TEAM_TABS = ['access', 'documents', 'ai']
  const TABS = ['overview', ...TEAM_TABS, 'settings']
  let currentTab = 'overview'
  const viewListeners = new Set()

  // ---- errors: beside the control that failed, else in the open dialog, else under the tab's heading
  const slotFor = (target) => {
    const element = typeof target === 'string' ? byId(target) : target
    if (element instanceof Element) {
      if (element.matches('.tab-error, .dialog-error, .field-error')) return element
      const named = element.getAttribute('aria-errormessage')
      if (named && byId(named)) return byId(named)
      const existing = element.parentElement?.querySelector(`[data-error-for="${CSS.escape(element.id)}"]`)
      if (existing) return existing
      const slot = document.createElement('p')
      slot.className = 'field-error'
      slot.setAttribute('role', 'alert')
      slot.dataset.errorFor = element.id
      slot.hidden = true
      const anchor = element.closest('.row, label, .switch') ?? element
      anchor.insertAdjacentElement('afterend', slot)
      return slot
    }
    const dialog = document.querySelector('dialog[open]')
    const inDialog = dialog && [...dialog.querySelectorAll('.dialog-error')].find((node) => !node.parentElement.closest('[hidden]'))
    return inDialog ?? byId(`tab-${currentTab}`)?.querySelector('.tab-error') ?? byId('error')
  }
  const reportError = (error, target) => {
    const slot = slotFor(target)
    slot.textContent = String(error?.message ?? error)
    slot.hidden = false
    const element = typeof target === 'string' ? byId(target) : target
    if (element instanceof Element && /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) element.setAttribute('aria-invalid', 'true')
  }
  const clearError = (target) => {
    const slot = slotFor(target)
    slot.hidden = true
    slot.textContent = ''
    const element = typeof target === 'string' ? byId(target) : target
    if (element instanceof Element) element.removeAttribute('aria-invalid')
  }
  /** Runs an action and reports its failure where the person is looking; it never locks the page. */
  const attempt = (action, { target } = {}) => {
    clearError(target)
    return Promise.resolve().then(action).catch((error) => reportError(error, target))
  }

  // ---- footer: one line; an unresolved problem outranks any later note until that same change succeeds
  const problems = new Map()
  let note = ''
  const renderFooter = () => {
    const status = byId('save-status')
    status.replaceChildren()
    if (!problems.size) { status.textContent = note; return }
    for (const [index, problem] of [...problems.values()].entries()) {
      const line = document.createElement('span')
      line.className = 'save-problem'
      const message = document.createElement('span')
      message.id = `save-problem-${index}`
      message.textContent = problem.message
      line.append(message)
      if (problem.retry) {
        const retry = document.createElement('button')
        retry.textContent = t('shell.tryAgain')
        retry.setAttribute('aria-describedby', message.id)
        retry.onclick = () => problem.retry()
        line.append(' ', retry)
      }
      status.append(line)
    }
  }
  const footer = {
    note: (text) => { note = text; renderFooter() },
    current: () => note,
    problem: (group, problem) => { problems.delete(group); if (problem) problems.set(group, problem); renderFooter() },
    problems: () => [...problems.keys()],
    forget: (prefix) => { for (const group of [...problems.keys()]) if (group.startsWith(prefix)) problems.delete(group); renderFooter() },
  }

  /** A system notification; with notifications off, the footer says it instead. */
  const notify = async (title, body) => {
    try { await invoke('executor_notify', { title, body }) } catch { footer.note(`${title}: ${body}`) }
  }

  /** Rebuilding a list keeps keyboard focus on the same row's control, or moves it somewhere deliberate. */
  const keepFocus = (container, rebuild, fallback) => {
    const key = container.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
    rebuild()
    if (key === undefined) return
    const again = [...container.querySelectorAll('[data-key]')].find((node) => node.dataset.key === key && !node.disabled)
    ;(again ?? fallback?.())?.focus()
  }

  // ---- dialogs
  const dialogs = {
    open: (id) => {
      const dialog = byId(id)
      for (const slot of dialog.querySelectorAll('.dialog-error')) slot.hidden = true
      if (!dialog.open) dialog.showModal()
      ;(dialog.querySelector('[autofocus]') ?? dialog.querySelector('h2')).focus()
      return dialog
    },
    close: (id) => { const dialog = byId(id); if (dialog.open) dialog.close() },
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.dialog-close')
    if (button) button.closest('dialog').close()
  })

  // ---- tabs and the team row
  const tabs = [...document.querySelectorAll('[role=tab]')]
  const renderTeamRow = () => {
    const teams = nc.team.list()
    const scoped = TEAM_TABS.includes(currentTab)
    byId('team-row').hidden = !scoped || !teams.length
    byId('no-team').hidden = !scoped || Boolean(teams.length)
    const select = byId('team-select')
    select.replaceChildren()
    for (const team of teams) {
      const option = document.createElement('option')
      option.value = team.executorId
      option.textContent = nc.team.label(team.executorId)
      select.append(option)
    }
    select.value = nc.team.current() ?? ''
    for (const tab of TEAM_TABS) byId(`tab-${tab}`).hidden = currentTab !== tab || !teams.length
  }
  const showTab = (tab) => {
    if (!TABS.includes(tab)) return
    currentTab = tab
    for (const button of tabs) {
      const selected = button.dataset.tab === tab
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    }
    byId('tab-overview').hidden = tab !== 'overview'
    byId('tab-settings').hidden = tab !== 'settings'
    renderTeamRow()
    for (const listener of viewListeners) listener(tab)
  }
  for (const button of tabs) {
    button.onclick = () => showTab(button.dataset.tab)
    button.onkeydown = (event) => {
      const index = tabs.indexOf(button)
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key]
      if (next === undefined) return
      event.preventDefault()
      const target = tabs[(next + tabs.length) % tabs.length]
      target.focus()
      showTab(target.dataset.tab)
    }
  }
  byId('team-select').onchange = () => attempt(() => nc.team.select(byId('team-select').value))
  byId('open-nessie').onclick = () => attempt(() => invoke('executor_open_nessie', {
    apiBaseUrl: nc.team.apiBaseUrl(nc.team.current()) ?? 'nessie',
  }))

  // Static words. Everything else is written by the script that owns it.
  document.title = t('shell.title')
  byId('app-title').textContent = t('shell.title')
  for (const button of tabs) button.textContent = t(`shell.${button.dataset.tab}`)
  byId('tablist').setAttribute('aria-label', t('shell.tabs'))
  byId('team-select-label').textContent = t('shell.team')
  byId('open-nessie').textContent = t('shell.openNessie')
  byId('no-team-text').textContent = t('shell.noTeam')
  byId('no-team-connect').textContent = t('shell.connectTeam')

  Object.assign(nc, {
    byId, invoke, listen, attempt, reportError, clearError, footer, notify, keepFocus, dialogs,
    view: {
      current: () => currentTab,
      show: showTab,
      onChange: (listener) => { viewListeners.add(listener); return () => viewListeners.delete(listener) },
      teamTabs: TEAM_TABS,
    },
  })

  /**
   * The menu bar and notification area open a tab with `tray://section/<name>`;
   * the payload may name the team to show first. `tray://connect` opens Connect
   * a team. A team this window does not list is ignored, and the tab still opens.
   */
  const openSection = async (tab, target) => {
    const executorId = typeof target?.executorId === 'string' ? target.executorId : null
    if (executorId && nc.team.list().some((team) => team.executorId === executorId)) await nc.team.select(executorId)
    showTab(tab)
  }
  for (const tab of TABS) listen(`tray://section/${tab}`, (target) => attempt(() => openSection(tab, target)))
  listen('tray://connect', () => attempt(() => nc.pairing.open()))

  window.addEventListener('DOMContentLoaded', () => {
    nc.team.onListChange(renderTeamRow)
    nc.team.onChange(() => { byId('team-select').value = nc.team.current() ?? '' })
    byId('no-team-connect').onclick = () => attempt(() => nc.pairing.open())
    attempt(async () => {
      try { await nc.team.refresh() } catch (error) { reportError(error) }
      try { await nc.pairing.restore() } catch (error) { reportError(error) }
    })
    setInterval(() => { nc.team.refresh().catch((error) => reportError(error)) }, 5000)
    showTab('overview')
  })
})()
