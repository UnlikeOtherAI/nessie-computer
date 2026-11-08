const { invoke, listen } = window.executorNative
const byId = (id) => document.getElementById(id)
let connections = []
let currentExecutorId = null
let description = null
let loadFailed = false
let currentTab = 'teams'
const TEAM_TABS = ['folders', 'commands', 'sync']
const connectionNames = new Map()
const lookupFailed = new Set()
const connectionLabel = (connection) => [connection?.organizationName, connection?.teamName].filter(Boolean).join(' / ')
const teamLabel = (executorId) => connectionLabel(connectionNames.get(executorId))
  || (lookupFailed.has(executorId) ? 'Team name unavailable' : 'Checking team…')
const serverHost = (executorId) => {
  const url = connectionNames.get(executorId)?.apiBaseUrl
  return url ? new URL(url).host : null
}

/** A failure shows where the person is looking: in the open dialog, above its buttons, or under the tabs. */
const reportError = (error) => {
  const dialog = document.querySelector('dialog[open]')
  const inDialog = dialog && [...dialog.querySelectorAll('.dialog-error')]
    .find((node) => !node.parentElement.closest('[hidden]'))
  const target = inDialog ?? byId('error')
  target.textContent = String(error?.message ?? error)
  target.hidden = false
  // The address the error is about is marked as the field to correct.
  if (target.id === 'pairing-form-error') byId('pairing-server').setAttribute('aria-invalid', 'true')
}
const clearErrors = () => { for (const node of document.querySelectorAll('#error, .dialog-error')) node.hidden = true }
// Actions report their own failure and never lock the page while they run.
const attempt = (action) => {
  clearErrors()
  return Promise.resolve().then(action).catch(reportError)
}

/**
 * The footer line. An unresolved save problem — one per team and section —
 * outranks any later news and stays until that same change succeeds; only
 * then does the footer go back to the latest note.
 */
const saveProblems = new Map()
let saveNote = ''
const renderSaveStatus = () => {
  const status = byId('save-status')
  status.replaceChildren()
  if (!saveProblems.size) {
    status.textContent = saveNote
    return
  }
  // Every open problem is listed, newest last, so none hides another.
  for (const [index, problem] of [...saveProblems.values()].entries()) {
    const line = document.createElement('span')
    line.className = 'save-problem'
    const message = document.createElement('span')
    message.id = `save-problem-${index}`
    message.textContent = problem.message
    line.append(message)
    if (problem.retry) {
      const retry = document.createElement('button')
      retry.textContent = 'Try again'
      retry.setAttribute('aria-describedby', message.id)
      retry.onclick = () => problem.retry()
      line.append(' ', retry)
    }
    status.append(line)
  }
}
const setSaveNote = (text) => { saveNote = text; renderSaveStatus() }
const setSaveProblem = (group, problem) => {
  saveProblems.delete(group)
  if (problem) saveProblems.set(group, problem)
  renderSaveStatus()
}
/** A removed team's problems and unsaved draft go with it: nothing is left to save them to. */
const forgetTeamProblems = (executorId) => {
  for (const group of [...saveProblems.keys()]) if (group.startsWith(`${executorId}:`)) saveProblems.delete(group)
  drafts.delete(executorId)
  renderSaveStatus()
}

// The latest save that succeeded since the queue was last idle; it is
// reported once, in the footer and as a notification, when everything is done.
let savedSinceIdle = null
autosave.onIdle(async () => {
  const saved = savedSinceIdle
  savedSinceIdle = null
  if (!saved) {
    if (saveNote.startsWith('Saving')) setSaveNote('')
    return
  }
  setSaveNote('Settings saved')
  await notify('Settings saved', saved)
})

/** A system notification; with notifications turned off, the footer says it instead. */
const notify = async (title, body) => {
  try { await invoke('executor_notify', { title, body }) } catch { setSaveNote(`${title}: ${body}`) }
}

/** Rebuilding a list keeps keyboard focus on the same row's control, or moves it somewhere deliberate. */
const keepFocus = (container, rebuild, fallback) => {
  const key = container.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
  rebuild()
  if (key === undefined) return
  const again = [...container.querySelectorAll('[data-key]')].find((node) => node.dataset.key === key && !node.disabled)
  ;(again ?? fallback()).focus()
}

/**
 * Folders and Commands appear only once the picked team's settings have
 * loaded, so a field can never show one team's values while the picker names
 * another.
 */
const renderTeamState = () => {
  const scoped = TEAM_TABS.includes(currentTab) || currentTab === 'ai'
  const loading = TEAM_TABS.includes(currentTab) && Boolean(currentExecutorId) && description?.executorId !== currentExecutorId
  byId('no-team').hidden = !(scoped && !currentExecutorId)
  byId('team-loading').hidden = !loading
  byId('team-loading-text').textContent = !loading ? ''
    : loadFailed ? `Couldn’t load settings for ${teamLabel(currentExecutorId)}.`
      : `Loading settings for ${teamLabel(currentExecutorId)}…`
  byId('team-reload').hidden = !loadFailed
  byId('tab-ai').hidden = currentTab !== 'ai' || !currentExecutorId
  for (const tab of TEAM_TABS) byId(`tab-${tab}`).hidden = currentTab !== tab || !currentExecutorId || loading
}

const loadDescription = async () => {
  const id = currentExecutorId
  loadFailed = false
  renderTeamState()
  // Saves still waiting read the fields as they are; they finish before new values replace them.
  await autosave.flush()
  try {
    const next = await invoke('executor_describe', { executorId: id })
    if (id !== currentExecutorId) return
    description = next
    renderPermissions(next, { fields: true })
    restoreDrafts(id)
  } catch (error) {
    if (id !== currentExecutorId) return
    loadFailed = true
    throw new Error(`Couldn’t load settings for ${teamLabel(id)}. ${error?.message ?? error}`)
  } finally { renderTeamState() }
}

const selectTeam = async (executorId) => {
  if (executorId === currentExecutorId) return
  currentExecutorId = executorId
  description = null
  byId('connection').value = executorId ?? ''
  renderTeamState()
  if (executorId && TEAM_TABS.includes(currentTab)) await loadDescription()
  if (currentTab === 'ai') await loadAi()
}

const tabs = [...document.querySelectorAll('[role=tab]')]
const showTab = async (tab) => {
  currentTab = tab
  for (const button of tabs) {
    const selected = button.dataset.tab === tab
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  byId('tab-teams').hidden = tab !== 'teams'
  byId('tab-settings').hidden = tab !== 'settings'
  if (tab === 'ai') void loadAi()
  renderTeamState()
  if (TEAM_TABS.includes(tab) && currentExecutorId && description?.executorId !== currentExecutorId) await loadDescription()
}
for (const button of tabs) {
  button.onclick = () => attempt(() => showTab(button.dataset.tab))
  button.onkeydown = (event) => {
    const index = tabs.indexOf(button)
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const target = tabs[(next + tabs.length) % tabs.length]
    target.focus()
    attempt(() => showTab(target.dataset.tab))
  }
}

for (const button of document.querySelectorAll('.dialog-close')) button.onclick = () => button.closest('dialog').close()
for (const button of document.querySelectorAll('[data-action=pair]')) button.onclick = () => attempt(openPairDialog)
byId('connection').onchange = () => attempt(() => selectTeam(byId('connection').value))
byId('team-reload').onclick = () => attempt(loadDescription)
byId('hide').onclick = () => attempt(async () => { await autosave.flush(); await invoke('executor_hide_status') })
byId('open-nessie').onclick = () => attempt(() => invoke('executor_open_nessie', {
  apiBaseUrl: connectionNames.get(currentExecutorId)?.apiBaseUrl ?? 'nessie',
}))
/**
 * The tray and the menu bar open a tab with `tray://section/<name>`. Their
 * payload may name the team to show first (`{ executorId }`), as the Sync line
 * does for the team its status is about; a team this page does not list is
 * ignored, and the tab still opens.
 */
const openSection = async (tab, target) => {
  const executorId = typeof target?.executorId === 'string' ? target.executorId : null
  const listed = !connections.length || connections.some((connection) => connection.executorId === executorId)
  if (executorId && listed) await selectTeam(executorId)
  await showTab(tab)
}
for (const [event, tab] of [['teams', 'teams'], ['settings', 'settings'], ['reach', 'folders'], ['tools', 'commands'], ['sync', 'sync'], ['ai', 'ai']]) {
  listen(`tray://section/${event}`, (target) => attempt(() => openSection(tab, target)))
}
listen('tray://pair', () => attempt(openPairDialog))
window.addEventListener('DOMContentLoaded', () => {
  attempt(async () => {
    for (const load of [refresh, restorePairing, loadAutostart, loadAutoRestart]) {
      try { await load() } catch (error) { reportError(error) }
    }
  })
  setInterval(() => { refresh().catch(reportError) }, 5000)
})
