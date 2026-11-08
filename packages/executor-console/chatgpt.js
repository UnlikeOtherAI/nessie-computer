// Only public operations cross native IPC. The CLI independently resolves the
// selected pairing, fresh owner authority and native credential custody.
let chatgptExecutor = null
let chatgptView = null
let chatgptBusy = false
let chatgptReadFailed = false
let chatgptRequest = 0
let chatgptTimer = null
let chatgptNewId = null
let chatgptSelected = null
let chatgptNameDirty = false
const chatgptDialog = byId('chatgpt-dialog')
const chatgptWords = window.chatgptConsoleWords
const chatgptProfile = () => chatgptNewId ? null : chatgptView?.profiles.find(profile => profile.profileId === byId('chatgpt-profile').value)
const renderChatgpt = () => {
  const profile = chatgptProfile()
  const reason = chatgptView?.reason ?? profile?.reason
  const phase = profile?.phase ?? 'disconnected'
  byId('chatgpt-status').textContent = chatgptReadFailed ? chatgptWords.failed
    : reason ? chatgptWords.unavailable[reason] ?? chatgptWords.unavailable.other
    : chatgptWords.phases[phase]
  const pending = ['signing_in', 'disconnecting'].includes(phase)
  byId('chatgpt-start').hidden = pending || phase === 'ready'
  byId('chatgpt-start').disabled = chatgptBusy || !byId('chatgpt-restriction').checked
    || Boolean(chatgptNewId && !byId('chatgpt-name').value.trim())
  byId('chatgpt-rename').hidden = !profile
  byId('chatgpt-rename').disabled = chatgptBusy || !byId('chatgpt-name').value.trim()
    || byId('chatgpt-name').value.trim() === profile?.label
  byId('chatgpt-restriction-row').hidden = pending || phase === 'ready'
  byId('chatgpt-cancel').hidden = phase !== 'signing_in' || !profile?.operationId
  byId('chatgpt-disconnect').hidden = !profile || ['disconnected', 'unavailable'].includes(phase)
  byId('chatgpt-background').hidden = !(profile?.backgroundConsentRevision
    || (!chatgptReadFailed && phase === 'ready' && profile?.planEnabled))
  byId('chatgpt-background').textContent = profile?.backgroundConsentRevision ? chatgptWords.backgroundOff
    : chatgptWords.backgroundOn
  for (const id of ['cancel', 'disconnect', 'background', 'refresh', 'profile']) byId(`chatgpt-${id}`).disabled = chatgptBusy
  byId('chatgpt-profile').hidden = byId('chatgpt-profile-label').hidden = Boolean(chatgptNewId) || (chatgptView?.profiles.length ?? 0) < 2
}
const applyChatgpt = (view) => {
  let previous = chatgptSelected ?? byId('chatgpt-profile').value
  if (chatgptNewId && view.profiles.some(profile => profile.profileId === chatgptNewId)) {
    previous = chatgptNewId
    chatgptNewId = null
  }
  chatgptSelected = null
  chatgptView = view
  chatgptReadFailed = false
  byId('chatgpt-profile').replaceChildren(...view.profiles.map((profile, index) => {
    const option = document.createElement('option')
    option.value = profile.profileId
    option.textContent = `${profile.label ?? `${chatgptWords.profile} ${index + 1}`} · ${chatgptWords.phases[profile.phase]}`
    return option
  }))
  if (view.profiles.some(profile => profile.profileId === previous)) byId('chatgpt-profile').value = previous
  if (!chatgptNameDirty) byId('chatgpt-name').value = chatgptProfile()?.label ?? ''
  renderChatgpt()
}
const chatgptOperation = async (operation, silent = false) => {
  if (chatgptBusy || !chatgptExecutor) return
  const asked = ++chatgptRequest
  const executorId = chatgptExecutor
  chatgptBusy = true
  renderChatgpt()
  try {
    const view = await invoke('executor_personal_chatgpt', { executorId, operation })
    if (asked === chatgptRequest && executorId === chatgptExecutor) {
      applyChatgpt(view)
      if (operation.operation !== 'status' && currentTab === 'ai') void loadAi()
    }
  } catch {
    if (asked === chatgptRequest && executorId === chatgptExecutor) {
      // A failed read invalidates authority-dependent actions, including old
      // ready state. A subsequent successful check restores the public view.
      chatgptReadFailed = true
      if (!silent) reportError(chatgptWords.failed)
    }
  } finally {
    if (asked === chatgptRequest) { chatgptBusy = false; renderChatgpt() }
  }
}
const checkChatgpt = () => chatgptOperation({ operation: 'status' })
const openChatgpt = async (executorId, profileId = null, creating = false) => {
  chatgptRequest += 1
  chatgptExecutor = executorId
  chatgptNewId = creating ? crypto.randomUUID() : null
  chatgptSelected = profileId
  chatgptNameDirty = false
  byId('chatgpt-name').value = ''
  chatgptView = null
  chatgptReadFailed = false
  chatgptBusy = false
  byId('chatgpt-profile').replaceChildren()
  byId('chatgpt-restriction').checked = false
  clearErrors()
  byId('chatgpt-team').textContent = teamLabel(executorId)
  renderChatgpt()
  chatgptDialog.showModal()
  byId('chatgpt-title').focus()
  await checkChatgpt()
  clearInterval(chatgptTimer)
  chatgptTimer = setInterval(() => {
    if (chatgptDialog.open) void checkChatgpt()
  }, 5000)
}
for (const id of ['disclosure', 'profile-label', 'restriction-copy', 'background-copy',
  'start', 'cancel', 'disconnect', 'refresh', 'usage', 'close']) {
  byId(`chatgpt-${id}`).textContent = chatgptWords[id]
}
byId('chatgpt-restriction').onchange = renderChatgpt
byId('chatgpt-name-label').textContent = window.aiConsoleWords.name
byId('chatgpt-rename').textContent = window.aiConsoleWords.rename
byId('chatgpt-name').oninput = () => { chatgptNameDirty = true; renderChatgpt() }
byId('chatgpt-rename').onclick = () => chatgptOperation({ operation: 'rename',
  profileId: chatgptProfile().profileId, label: byId('chatgpt-name').value.trim() })
byId('chatgpt-profile').onchange = () => {
  chatgptNameDirty = false
  byId('chatgpt-name').value = chatgptProfile()?.label ?? ''
  renderChatgpt()
}
byId('chatgpt-refresh').onclick = () => { clearErrors(); void checkChatgpt() }
byId('chatgpt-start').onclick = () => chatgptOperation({ operation: 'start', acknowledgeHostRestriction: true,
  ...(chatgptNewId ? { newProfileId: chatgptNewId, label: byId('chatgpt-name').value.trim() }
    : chatgptProfile() ? { profileId: chatgptProfile().profileId } : {}) })
byId('chatgpt-cancel').onclick = () => chatgptOperation({ operation: 'cancel', operationId: chatgptProfile().operationId })
byId('chatgpt-disconnect').onclick = () => chatgptOperation({ operation: 'disconnect', profileId: chatgptProfile().profileId })
byId('chatgpt-background').onclick = () => {
  const profile = chatgptProfile()
  return chatgptOperation({ operation: 'background-consent', profileId: profile.profileId,
    enabled: !profile.backgroundConsentRevision, expectedRevision: profile.backgroundConsentRevision })
}
byId('chatgpt-usage').onclick = () => attempt(() => invoke('executor_chatgpt_usage'))
chatgptDialog.addEventListener('close', () => {
  clearInterval(chatgptTimer)
  chatgptTimer = null
  // Closing this window is not canceling a sign-in or clearing native custody.
  chatgptExecutor = null
  chatgptRequest += 1
})
