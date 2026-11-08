let switchPending = null
let removing = null
let renderedView = ''
const STATUS = {
  running: 'Running', starting: 'Starting…', stopping: 'Stopping…', stopped: 'Off',
  'running elsewhere': 'Running in another app',
}
const isRunning = (connection) => ['running', 'starting'].includes(connection.daemonStatus)

const renderSwitch = () => {
  const toggle = byId('running')
  toggle.checked = switchPending ? switchPending === 'on' : connections.some(isRunning)
  toggle.disabled = !connections.length || Boolean(switchPending)
  byId('running-label').textContent = switchPending === 'on' ? 'Turning on…'
    : switchPending === 'off' ? 'Turning off…' : 'All team connections'
  // The switch controls this app's connections; one another app runs is counted beside it.
  const elsewhere = connections.filter((connection) => connection.daemonStatus === 'running elsewhere').length
  byId('running-elsewhere').hidden = !elsewhere
  byId('running-elsewhere').textContent = `${elsewhere} running in another app`
}

const renderConnections = () => keepFocus(byId('executors-list'), () => {
  const list = byId('executors-list')
  const select = byId('connection')
  list.replaceChildren()
  select.replaceChildren()
  byId('team-row').hidden = !connections.length
  if (!connections.length) {
    const empty = document.createElement('p')
    empty.textContent = 'Connect this computer to a team in Nessie.'
    list.append(empty)
  }
  const labels = connections.map((connection) => teamLabel(connection.executorId))
  for (const [index, connection] of connections.entries()) {
    const label = labels[index]
    const host = serverHost(connection.executorId)
    const option = document.createElement('option')
    option.value = connection.executorId
    // Two teams with one name are told apart by their server, or by their ID when the name is unknown.
    const shared = labels.filter((other) => other === label).length > 1
    option.textContent = !connectionNames.has(connection.executorId) ? `${label} (${connection.executorId.slice(0, 8)})`
      : shared && host ? `${label} (${host})` : label
    select.append(option)
    const row = document.createElement('div')
    row.className = 'connection-row'
    const name = document.createElement('div')
    name.className = 'connection-name'
    name.textContent = label
    const details = document.createElement('small')
    details.textContent = [STATUS[connection.daemonStatus] ?? connection.daemonStatus,
      host ?? `ID ${connection.executorId.slice(0, 8)}`].join(' · ')
    name.append(details)
    if (connection.detail) {
      const reason = document.createElement('small')
      reason.className = 'connection-detail'
      reason.textContent = connection.detail
      name.append(reason)
    }
    if (ownerConfirmationRequired.has(connection.executorId)) {
      const recovery = document.createElement('small')
      recovery.className = 'connection-detail'
      recovery.textContent = window.aiConsoleWords.restoreNames
      name.append(recovery)
    }
    const remove = document.createElement('button')
    remove.textContent = 'Remove'
    remove.setAttribute('aria-label', `Remove ${label} from this computer`)
    remove.dataset.key = connection.executorId
    remove.onclick = () => openRemove(connection.executorId)
    const chatgpt = document.createElement('button')
    chatgpt.textContent = 'AI'
    chatgpt.className = 'chatgpt-doorway'
    chatgpt.setAttribute('aria-label', `AI · ${label}`)
    chatgpt.onclick = () => attempt(() => openSection('ai', { executorId: connection.executorId }))
    row.append(name, chatgpt, remove)
    list.append(row)
  }
  if (!connections.some((connection) => connection.executorId === currentExecutorId)) {
    currentExecutorId = connections[0]?.executorId ?? null
    description = null
    renderTeamState()
    if (currentExecutorId && TEAM_TABS.includes(currentTab)) attempt(loadDescription)
  }
  select.value = currentExecutorId ?? ''
  renderSwitch()
}, () => byId('tab-teams').querySelector('[data-action=pair]'))

// The five-second refresh repaints only when something changed, so an open
// team picker is never closed under the person's pointer.
// Numbers each status request, so an answer can be told apart from one asked for later.
let statusRequests = 0
const beginStatusRequest = () => { statusRequests += 1; return statusRequests }

const applyView = (view, asked = 0) => {
  if (view.kind !== 'reachable') throw new Error(view.reason)
  connections = view.executors
  const signature = JSON.stringify([connections, connections.map((connection) => [
    teamLabel(connection.executorId), serverHost(connection.executorId), ownerConfirmationRequired.has(connection.executorId),
  ]), currentExecutorId, switchPending])
  clearRecoveredConnections(asked)
  if (signature === renderedView) return
  renderedView = signature
  renderConnections()
}

// A name lookup asks Nessie and can take many seconds, under a lock every
// pairing check shares. One pass runs at a time, and a refused name waits a
// minute, so the five-second refresh never queues lookups behind each other.
const NAME_RETRY_MS = 60_000
const nameRetryAt = new Map()
let namesInFlight = false
const lookUpNames = async (executors) => {
  if (namesInFlight) return
  namesInFlight = true
  try {
    for (const { executorId } of executors) {
      if (connectionNames.has(executorId) || (nameRetryAt.get(executorId) ?? 0) > Date.now()) continue
      try {
        connectionNames.set(executorId, await invoke('executor_pairing_status', { executorId }))
        lookupFailed.delete(executorId)
        ownerConfirmationRequired.delete(executorId)
        nameRetryAt.delete(executorId)
      } catch (error) {
        if (String(error?.message ?? error).includes('PAIRING_OWNER_CONFIRMATION_REQUIRED')) {
          ownerConfirmationRequired.add(executorId)
        }
        lookupFailed.add(executorId)
        nameRetryAt.set(executorId, Date.now() + NAME_RETRY_MS)
      }
    }
  } finally { namesInFlight = false }
}

const refresh = async () => {
  const asked = beginStatusRequest()
  const view = await invoke('executor_view')
  if (view.kind !== 'reachable') throw new Error(view.reason)
  await lookUpNames(view.executors)
  applyView(view, asked)
}

// The switch waits in the same queue as saves: a save already reconnecting a
// team finishes first, so it cannot turn that team back on afterwards.
byId('running').onchange = () => {
  const running = byId('running').checked
  switchPending = running ? 'on' : 'off'
  renderSwitch()
  attempt(() => autosave.now('switch', () => applySwitch(running)))
}
const applySwitch = async (running) => {
  try {
    const asked = beginStatusRequest()
    applyView(await invoke('executor_set_running', { running }), asked)
    if (running) {
      // Whatever the footer said about the connections being off no longer holds.
      if (!saveNote.startsWith('Saving')) setSaveNote('')
      return
    }
    // Turned off on purpose: a team that did not come back after a save is no longer a problem.
    for (const group of [...saveProblems.keys()]) if (group.endsWith(':connection')) saveProblems.delete(group)
    renderSaveStatus()
    const elsewhere = connections.filter((connection) => connection.daemonStatus === 'running elsewhere')
      .map((connection) => teamLabel(connection.executorId))
    if (elsewhere.length) {
      reportError(`${elsewhere.join(', ')} ${elsewhere.length > 1 ? 'are' : 'is'} running in another app. Turn it off there.`)
    }
    setSaveNote('Team connections are off until Nessie Executor next opens.')
    await notify('Team connections off', 'They turn on again when Nessie Executor next opens.')
  } finally {
    switchPending = null
    renderSwitch()
    await refresh()
  }
}

const openRemove = (executorId) => {
  removing = executorId
  clearErrors()
  byId('remove-summary').textContent = `Remove ${teamLabel(executorId)} from this computer? `
    + 'Nessie will show this computer as disconnected for that team.'
  byId('remove-dialog').showModal()
  byId('remove-cancel').focus()
}

// While a removal runs, the dialog cannot be dismissed: closing it would not stop the removal.
byId('remove-dialog').addEventListener('cancel', (event) => { if (byId('remove-confirm').disabled) event.preventDefault() })
byId('remove-confirm').onclick = () => attempt(async () => {
  const executorId = removing
  const label = teamLabel(executorId)
  const [confirm, cancel] = [byId('remove-confirm'), byId('remove-cancel')]
  confirm.disabled = cancel.disabled = true
  confirm.textContent = 'Removing…'
  try {
    await autosave.flush()
    const result = await invoke('executor_remove', { executorId })
    byId('remove-dialog').close()
    connectionNames.delete(executorId)
    forgetTeamProblems(executorId)
    await refresh()
    byId('tab-teams').querySelector('[data-action=pair]').focus()
    if (result?.signedOff) await notify('Team removed', `Nessie now shows this computer as disconnected for ${label}.`)
    else reportError(`${label} was removed from this computer, but Nessie couldn’t be told. `
      + 'It will show this computer as offline until someone removes it there.')
  } finally {
    confirm.disabled = cancel.disabled = false
    confirm.textContent = 'Remove team'
  }
})
