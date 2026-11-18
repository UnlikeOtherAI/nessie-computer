// On Windows a ChatGPT plan's sign-in is held by the background service, so
// the first plan for a team this app runs needs one more connection to that
// team: one Windows prompt, then a pairing code the owner enters in Nessie.
// This dialog shows that code and waits for the claim; nothing is confirmed
// here. The claimed connection is the team's plan connection (teams.js).
window.aiConnection = (() => {
  const nc = window.nc
  const { byId, invoke, t } = nc
  const dialog = document.createElement('dialog')
  dialog.id = 'ai-connection-dialog'
  dialog.setAttribute('aria-labelledby', 'ai-connection-title')
  dialog.innerHTML = `
    <h2 id="ai-connection-title" tabindex="-1"></h2>
    <p id="ai-connection-starting" role="status" hidden></p>
    <section id="ai-connection-progress" hidden>
      <div id="ai-connection-code-row" class="code-row"><output id="ai-connection-code"></output></div>
      <p id="ai-connection-time" class="hint"></p>
      <p id="ai-connection-instruction"></p>
    </section>
    <p class="dialog-error" role="alert" hidden></p>
    <div class="actions">
      <button type="button" id="ai-connection-cancel"></button>
      <button type="button" id="ai-connection-renew" class="primary" hidden></button>
      <button type="button" id="ai-connection-open-nessie" class="primary" hidden></button>
    </div>`
  document.body.append(dialog)
  let executorId = null
  let view = null
  let settle = null // resolves the connect() promise with the plan connection id, or null
  let timer = null

  let busy = false
  let retry = null
  const errorBox = dialog.querySelector('[role=alert]')

  const secondsLeft = () => Math.max(0, Math.ceil((Date.parse(view?.expiresAt ?? '') - Date.now()) / 1000) || 0)
  const expired = () => view?.status === 'expired' || (view?.status === 'waiting' && secondsLeft() === 0)
  const render = () => {
    const starting = view === null && !retry
    const gone = expired()
    byId('ai-connection-starting').hidden = !starting
    byId('ai-connection-progress').hidden = !view || !!retry
    byId('ai-connection-code').textContent = view?.code ?? ''
    byId('ai-connection-code').classList.toggle('expired', gone)
    byId('ai-connection-instruction').textContent = gone ? t('pairing.expired') : t('pairing.instruction')
    const seconds = secondsLeft()
    byId('ai-connection-time').textContent = view?.status === 'waiting' && seconds > 0
      ? t('pairing.expiresIn', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }) : ''
    byId('ai-connection-renew').hidden = !retry && !gone
    byId('ai-connection-renew').textContent = t(retry ? 'shell.tryAgain' : 'pairing.newCode')
    byId('ai-connection-renew').disabled = busy
    byId('ai-connection-cancel').disabled = busy
    byId('ai-connection-cancel').textContent = t(retry ? 'shell.close' : 'shell.cancel')
    byId('ai-connection-open-nessie').hidden = !view || !!retry || gone
  }

  const finish = (planConnectionId) => {
    clearInterval(timer)
    timer = null
    if (dialog.open) dialog.close()
    settle?.(planConnectionId)
    settle = null
  }
  const accept = async (next) => {
    if (next?.status === 'waiting' && (!/^\d{8}$/.test(next.code) || !Number.isFinite(Date.parse(next.expiresAt)))) {
      throw new Error(t('ai.failed'))
    }
    view = next
    if (next.status === 'paired' || next.status === 'alreadyPaired') {
      await nc.team.refresh()
      const linked = nc.team.planConnectionOf(executorId)
      if (!linked) throw new Error(t('ai.connection.unlinked'))
      nc.footer.note(t('ai.connection.paired'))
      finish(linked)
    } else if (next.status !== 'waiting' && next.status !== 'expired') {
      view = null
      throw new Error(t('ai.connection.ended'))
    }
  }

  // Only an explicit retry may request Windows approval. Polls never prompt.
  const run = async (action, explicit = false) => {
    if (busy || !dialog.open) return
    busy = true
    retry = null
    errorBox.hidden = true
    render()
    try {
      if (action === 'cancel' || action === 'renew') {
        if (view?.status === 'waiting' || view?.status === 'expired') await invoke('executor_chatgpt_connection_cancel', { executorId })
        view = null
        if (action === 'cancel') { finish(null); return }
      }
      const next = action === 'status'
        ? await invoke('executor_chatgpt_connection_status', { executorId, retry: explicit })
        : await invoke('executor_chatgpt_connection_start', { executorId })
      await accept(next)
    } catch (error) {
      retry = action === 'cancel' ? 'cancel' : view ? 'status' : 'start'
      errorBox.textContent = nc.failure.sentence(error).text
      errorBox.hidden = false
    } finally {
      busy = false
      render()
    }
  }

  /** Connects the service to the team; answers the plan connection's id once Nessie claims it, null when cancelled. */
  const connect = (team) => new Promise((resolve) => {
    executorId = team
    settle = resolve
    byId('ai-connection-title').textContent = t('ai.connection.title', { team: nc.team.label(team) })
    byId('ai-connection-starting').textContent = t('ai.connection.starting')
    byId('ai-connection-cancel').textContent = t('shell.cancel')
    byId('ai-connection-renew').textContent = t('pairing.newCode')
    byId('ai-connection-open-nessie').textContent = t('pairing.openNessie')
    byId('ai-connection-code').setAttribute('aria-label', t('pairing.codeLabel'))
    dialog.lang = document.documentElement.lang
    nc.dialogs.open('ai-connection-dialog')
    view = null
    retry = null
    run('start')
    clearInterval(timer)
    timer = setInterval(() => {
      if (!busy && !retry && view?.status === 'waiting') run('status')
      else render()
    }, 1000)
  })
  const cancel = () => { if (retry) finish(null); else run('cancel') }
  byId('ai-connection-cancel').onclick = cancel
  byId('ai-connection-renew').onclick = () => run(retry ?? 'renew', true)
  // The host adds the code to the Computers page while it shows (§5.1).
  byId('ai-connection-open-nessie').onclick = () => nc.attempt(() => invoke('executor_open_nessie', {}))
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); cancel() })
  return { connect }
})()
