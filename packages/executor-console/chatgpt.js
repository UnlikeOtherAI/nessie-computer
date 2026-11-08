// The ChatGPT plan dialog. Only public operations cross native IPC; the CLI
// independently resolves the selected team, fresh owner authority and native
// credential custody. A plan is named by the person and signed in with
// ChatGPT's own OAuth sign-in; there is no "personal" plan.
window.chatgptDialog = (() => {
  const nc = window.nc
  const t = (key, vars) => nc.t(`chatgpt.${key}`, vars)
  const REASONS = ['other', 'host_sessions_active', 'host_restriction_acknowledgement_required', 'service_barrier_unavailable',
    'native_context_unsupported', 'deployment_ineligible', 'owner_authority_unavailable']
  let executor = null
  let view = null
  let busy = false
  let readFailed = false
  let request = 0
  let timer = null
  let newId = null
  let selected = null
  let nameDirty = false
  const dialog = document.createElement('dialog')
  dialog.id = 'chatgpt-dialog'
  dialog.setAttribute('aria-labelledby', 'chatgpt-title')
  dialog.innerHTML = `
    <h2 id="chatgpt-title" tabindex="-1"></h2>
    <p id="chatgpt-team"></p>
    <label id="chatgpt-name-label" for="chatgpt-name"></label>
    <div class="ai-name-row"><input id="chatgpt-name" maxlength="80"><button type="button" id="chatgpt-rename"></button></div>
    <p id="chatgpt-disclosure"></p>
    <p id="chatgpt-status" role="status"></p>
    <label id="chatgpt-profile-label" for="chatgpt-profile"></label>
    <select id="chatgpt-profile"></select>
    <label class="toggle" id="chatgpt-restriction-row"><input id="chatgpt-restriction" type="checkbox"><span id="chatgpt-restriction-copy"></span></label>
    <p id="chatgpt-background-copy" class="hint"></p>
    <p class="dialog-error" role="alert" hidden></p>
    <div class="actions chatgpt-actions">
      <button type="button" id="chatgpt-start" class="primary"></button>
      <button type="button" id="chatgpt-cancel"></button>
      <button type="button" id="chatgpt-background"></button>
      <button type="button" id="chatgpt-disconnect"></button>
      <button type="button" id="chatgpt-refresh"></button>
      <button type="button" id="chatgpt-usage"></button>
      <button type="button" id="chatgpt-close"></button>
    </div>`
  document.body.append(dialog)
  const byId = nc.byId
  const profile = () => (newId ? null : view?.profiles.find((entry) => entry.profileId === byId('chatgpt-profile').value))

  const render = () => {
    const current = profile()
    const reason = view?.reason ?? current?.reason
    const phase = current?.phase ?? 'disconnected'
    byId('chatgpt-status').textContent = readFailed ? t('failed')
      : reason ? t(`unavailable.${REASONS.includes(reason) ? reason : 'other'}`) : t(`phases.${phase}`)
    const pending = ['signing_in', 'disconnecting'].includes(phase)
    byId('chatgpt-start').hidden = pending || phase === 'ready'
    byId('chatgpt-start').disabled = busy || !byId('chatgpt-restriction').checked || Boolean(newId && !byId('chatgpt-name').value.trim())
    byId('chatgpt-rename').hidden = !current
    byId('chatgpt-rename').disabled = busy || !byId('chatgpt-name').value.trim() || byId('chatgpt-name').value.trim() === current?.label
    byId('chatgpt-restriction-row').hidden = pending || phase === 'ready'
    byId('chatgpt-cancel').hidden = phase !== 'signing_in' || !current?.operationId
    byId('chatgpt-disconnect').hidden = !current || ['disconnected', 'unavailable'].includes(phase)
    // Background work is kept: off until allowed here, with its revision fencing each change.
    byId('chatgpt-background').hidden = !(current?.backgroundConsentRevision || (!readFailed && phase === 'ready' && current?.planEnabled))
    byId('chatgpt-background').textContent = current?.backgroundConsentRevision ? t('backgroundOff') : t('backgroundOn')
    for (const id of ['cancel', 'disconnect', 'background', 'refresh', 'profile']) byId(`chatgpt-${id}`).disabled = busy
    byId('chatgpt-profile').hidden = byId('chatgpt-profile-label').hidden = Boolean(newId) || (view?.profiles.length ?? 0) < 2
  }
  const apply = (next) => {
    let previous = selected ?? byId('chatgpt-profile').value
    if (newId && next.profiles.some((entry) => entry.profileId === newId)) {
      previous = newId
      newId = null
      byId('chatgpt-title').textContent = t('title')
    }
    selected = null
    view = next
    readFailed = false
    byId('chatgpt-profile').replaceChildren(...next.profiles.map((entry, index) => {
      const option = document.createElement('option')
      option.value = entry.profileId
      option.textContent = `${window.aiTab.planName(entry, index)} · ${t(`phases.${entry.phase}`)}`
      return option
    }))
    if (next.profiles.some((entry) => entry.profileId === previous)) byId('chatgpt-profile').value = previous
    if (!nameDirty && !newId) byId('chatgpt-name').value = profile()?.label ?? ''
    render()
  }
  const operation = async (payload, silent = false) => {
    if (busy || !executor) return
    const asked = ++request
    const executorId = executor
    busy = true
    render()
    try {
      const next = await nc.invoke('executor_personal_chatgpt', { executorId, operation: payload })
      if (asked === request && executorId === executor) {
        apply(next)
        if (payload.operation !== 'status') void window.aiTab.load()
      }
    } catch {
      if (asked === request && executorId === executor) {
        // A failed read invalidates authority-dependent actions, including old
        // ready state. A later successful check restores the public view.
        readFailed = true
        if (!silent) throw new Error(t('failed'))
      }
    } finally {
      if (asked === request) { busy = false; render() }
    }
  }
  const check = () => operation({ operation: 'status' }, true)

  /** Opens a plan, or a new one whose name is prefilled "ChatGPT plan N" and editable. */
  const open = async (executorId, profileId = null, number = null) => {
    request += 1
    executor = executorId
    newId = number ? crypto.randomUUID() : null
    selected = profileId
    nameDirty = false
    view = null
    readFailed = false
    busy = false
    byId('chatgpt-profile').replaceChildren()
    byId('chatgpt-restriction').checked = false
    byId('chatgpt-title').textContent = newId ? t('newTitle') : t('title')
    byId('chatgpt-name').value = newId ? nc.t('ai.planName', { n: number }) : ''
    byId('chatgpt-team').textContent = nc.team.label(executorId)
    for (const [id, key] of [['disclosure', 'disclosure'], ['profile-label', 'profileLabel'], ['restriction-copy', 'restriction'],
      ['background-copy', 'background'], ['start', 'start'], ['cancel', 'cancel'], ['disconnect', 'disconnect'], ['refresh', 'refresh'],
      ['usage', 'usage'], ['close', 'close']]) byId(`chatgpt-${id}`).textContent = t(key)
    byId('chatgpt-name-label').textContent = nc.t('ai.name')
    byId('chatgpt-rename').textContent = nc.t('ai.rename')
    dialog.lang = document.documentElement.lang
    render()
    dialog.showModal()
    byId(newId ? 'chatgpt-name' : 'chatgpt-title').focus()
    if (newId) byId('chatgpt-name').select()
    await check()
    clearInterval(timer)
    timer = setInterval(() => { if (dialog.open) void check() }, 5000)
  }
  const act = (payload) => nc.attempt(() => operation(payload), { target: byId('chatgpt-status') })
  byId('chatgpt-restriction').onchange = render
  byId('chatgpt-name').oninput = () => { nameDirty = true; render() }
  byId('chatgpt-rename').onclick = () => act({ operation: 'rename', profileId: profile().profileId, label: byId('chatgpt-name').value.trim() })
  byId('chatgpt-profile').onchange = () => {
    nameDirty = false
    byId('chatgpt-name').value = profile()?.label ?? ''
    render()
  }
  byId('chatgpt-refresh').onclick = () => act({ operation: 'status' })
  byId('chatgpt-start').onclick = () => act({ operation: 'start', acknowledgeHostRestriction: true,
    ...(newId ? { newProfileId: newId, label: byId('chatgpt-name').value.trim() } : profile() ? { profileId: profile().profileId } : {}) })
  byId('chatgpt-cancel').onclick = () => act({ operation: 'cancel', operationId: profile().operationId })
  byId('chatgpt-disconnect').onclick = () => act({ operation: 'disconnect', profileId: profile().profileId })
  byId('chatgpt-background').onclick = () => {
    const current = profile()
    return act({ operation: 'background-consent', profileId: current.profileId,
      enabled: !current.backgroundConsentRevision, expectedRevision: current.backgroundConsentRevision })
  }
  byId('chatgpt-usage').onclick = () => nc.attempt(() => nc.invoke('executor_chatgpt_usage'), { target: byId('chatgpt-usage') })
  byId('chatgpt-close').onclick = () => dialog.close()
  dialog.addEventListener('close', () => {
    clearInterval(timer)
    timer = null
    // Closing this window is not cancelling a sign-in or clearing native custody.
    executor = null
    request += 1
  })
  return { open, reasons: Object.fromEntries(REASONS.map((reason) => [reason, true])) }
})()
