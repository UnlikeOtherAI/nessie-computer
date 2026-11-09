// Add another team. Opening the dialog asks Nessie for a code straight away;
// the person types it in Nessie under Computers › Add a computer, and the
// claim there finishes the pairing. The computer asks nothing else, and the
// server address stays behind "Own Nessie server".
(() => {
  const nc = window.nc
  const { byId, invoke, t, attempt } = nc
  const DEFAULT_SERVER = 'https://api.nessie.works'
  let view = null
  let step = null
  let busy = false
  let poll = null
  // Each attempt has a number; an answer for an attempt that was cancelled is ignored.
  let attemptId = 0
  const actions = ['pairing-open-nessie', 'pairing-stop', 'pairing-renew', 'copy-code', 'pairing-server-use']

  const open = (status) => ['waiting', 'expired'].includes(status?.status)
  const secondsLeft = () => Math.max(0, Math.ceil((Date.parse(view?.expiresAt ?? '') - Date.now()) / 1000) || 0)
  const expired = (status) => status?.status === 'expired'
    || (status?.status === 'waiting' && Boolean(status.expiresAt) && Date.parse(status.expiresAt) <= Date.now())
  const announce = (text) => { byId('pairing-announce').textContent = text }
  /** The server the current attempt asked: a new code goes to the same one. */
  const server = () => view?.apiBaseUrl || DEFAULT_SERVER
  const ownServer = (address) => Boolean(address) && address !== DEFAULT_SERVER

  const render = (next) => {
    const gone = expired(next)
    const nextStep = gone ? 'expired' : next.status
    const failed = next.status === 'failed'
    const changed = nextStep !== step
    step = nextStep
    view = next
    const showing = open(next)
    byId('connect-progress').hidden = !showing
    byId('pairing-getting').hidden = showing || next.status !== 'getting'
    byId('pairing-code').textContent = showing ? next.code ?? '' : ''
    byId('pairing-code').classList.toggle('expired', gone)
    byId('copy-code').hidden = gone
    byId('copy-code').textContent = t('pairing.copy')
    byId('pairing-instruction').textContent = gone ? t('pairing.expired') : showing ? t('pairing.instruction') : ''
    // A code that ran out, or a request that failed, offers one button that asks again.
    byId('pairing-renew').hidden = !gone && !failed
    byId('pairing-renew').textContent = t(failed ? 'shell.tryAgain' : 'pairing.newCode')
    byId('pairing-open-nessie').hidden = !showing || gone
    tick()
    if (showing && changed && byId('connect-dialog').open) {
      byId('connect-title').focus()
      announce(byId('pairing-instruction').textContent)
    }
  }

  // The countdown is quiet for screen readers; only step changes are announced.
  const tick = () => {
    const seconds = secondsLeft()
    const counting = view?.status === 'waiting' && seconds > 0
    byId('pairing-time').textContent = counting
      ? t('pairing.expiresIn', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }) : ''
    if (step !== 'expired' && expired(view)) render(view)
    if (!busy) for (const id of actions) byId(id).disabled = false
  }

  /**
   * The claim in Nessie finishes the pairing: the first status that reads
   * `paired` closes the dialog, selects the team and opens its Access tab.
   */
  const finish = async (next) => {
    render(next)
    if (next.status !== 'paired') return
    byId('connect-dialog').close()
    await nc.team.refresh()
    if (next.executorId) {
      nc.team.select(next.executorId)
      nc.view.show('access')
      nc.footer.note(t('pairing.connected', { team: nc.team.label(next.executorId) }))
    }
  }

  /** One request at a time: the pressed control says what is happening and every other action waits. */
  const run = (button, pendingLabel, action, target) => attempt(async () => {
    const label = button?.textContent
    const mine = attemptId
    busy = true
    for (const id of actions) byId(id).disabled = true
    if (button) { button.disabled = true; button.textContent = pendingLabel }
    try {
      await poll
      const next = await action()
      if (next && mine === attemptId) await finish(next)
    } finally {
      busy = false
      if (button) { button.disabled = false; button.textContent = label }
      tick()
    }
  }, { target })

  /**
   * Asks for a code. A refusal is said in the dialog with Try again; it never
   * opens the server address, which only an organisation's own Nessie needs.
   */
  const start = (apiBaseUrl, button) => run(button, t('pairing.getting'), async () => {
    render({ status: 'getting' })
    try {
      return await invoke('executor_pairing_start', { apiBaseUrl })
    } catch (error) {
      render({ status: 'failed', apiBaseUrl })
      throw error
    }
  }, 'pairing-error')

  const cancel = (button) => run(button, t('shell.cancel'), async () => {
    attemptId += 1
    render(await invoke('executor_pairing_cancel'))
    byId('connect-dialog').close()
    await nc.team.refresh()
  })

  /** Opens the dialog and asks for a code at once, unless a code is already waiting. */
  const openDialog = async () => {
    // The address shows only for a code already waiting on an organisation's own server.
    const custom = open(view) && ownServer(view.apiBaseUrl)
    byId('pairing-server').value = custom ? view.apiBaseUrl : ''
    byId('connect-advanced').open = custom
    nc.dialogs.open('connect-dialog')
    if (open(view)) { render(view); return }
    await start(DEFAULT_SERVER, null)
  }
  /** An attempt left open when the app last closed reopens its dialog; answers whether it did. */
  const restore = async () => {
    const next = await invoke('executor_pairing_status')
    render(next)
    if (open(next)) nc.dialogs.open('connect-dialog')
    return open(next)
  }

  byId('connect-title').textContent = t('pairing.title')
  byId('pairing-getting').textContent = t('pairing.getting')
  byId('pairing-code').setAttribute('aria-label', t('pairing.codeLabel'))
  byId('copy-code').setAttribute('aria-label', t('pairing.copyLabel'))
  byId('pairing-open-nessie').textContent = t('pairing.openNessie')
  byId('pairing-stop').textContent = t('shell.cancel')
  byId('pairing-renew').textContent = t('pairing.newCode')
  byId('connect-advanced-summary').textContent = t('pairing.advanced')
  byId('pairing-server-label').textContent = t('pairing.serverLabel')
  const serverHelp = nc.help(t('pairing.serverHint'), { describes: byId('pairing-server') })
  serverHelp.id = 'pairing-server-help'
  byId('pairing-server-label').after(serverHelp)
  byId('pairing-server-use').textContent = t('pairing.useServer')
  byId('pairing-server').placeholder = 'https://nessie.example.com'

  /**
   * Asks the organisation's own server for a code. The host checks the address
   * before anything else, so a refused one leaves a waiting code as it was. An
   * accepted address answers with the code already waiting, if any: only then
   * is that code cancelled, when it belongs to another server, and a new one asked.
   */
  byId('pairing-server-use').onclick = () => {
    const address = byId('pairing-server').value.trim()
    const waiting = open(view) ? view : null
    run(byId('pairing-server-use'), t('pairing.getting'), async () => {
      let next
      try { next = await invoke('executor_pairing_start', { apiBaseUrl: address }) } catch (error) {
        if (!waiting) render({ status: 'idle' })
        throw error
      }
      const same = waiting && next.status === 'waiting' && next.code === waiting.code
        && next.apiBaseUrl === waiting.apiBaseUrl
      if (!same || waiting.apiBaseUrl === address) return next
      await invoke('executor_pairing_cancel')
      return invoke('executor_pairing_start', { apiBaseUrl: address })
    }, 'pairing-server')
  }
  byId('copy-code').onclick = () => attempt(async () => {
    if (view?.status !== 'waiting' || secondsLeft() === 0) return
    await invoke('executor_copy_code', { code: view.code })
    byId('copy-code').textContent = t('pairing.copied')
    announce(t('pairing.announceCopied'))
  })
  // The host knows the attempt's server and adds `?create=1&code=<code>` itself while the code shows (§5.1).
  byId('pairing-open-nessie').onclick = () => attempt(() => invoke('executor_open_nessie', {}))
  byId('pairing-stop').onclick = () => cancel(byId('pairing-stop'))
  byId('pairing-renew').onclick = () => {
    const address = server()
    if (step === 'failed') { start(address, byId('pairing-renew')); return }
    run(byId('pairing-renew'), t('pairing.getting'), async () => {
      // A pairing Nessie already accepted is finished, not replaced.
      const current = await invoke('executor_pairing_status')
      if (current.status === 'paired') return current
      await invoke('executor_pairing_cancel')
      return invoke('executor_pairing_start', { apiBaseUrl: address })
    })
  }
  // Escape during an attempt cancels it, rather than hiding a code that stays valid.
  byId('connect-dialog').addEventListener('cancel', (event) => {
    if (busy) { event.preventDefault(); return }
    if (!open(view)) return
    event.preventDefault()
    cancel(byId('pairing-stop'))
  })
  setInterval(tick, 1000)
  setInterval(() => {
    // Checks continue after the code runs out here: a claim made just before expiry still completes.
    if (busy || poll || !byId('connect-dialog').open || view?.status !== 'waiting') return
    const mine = attemptId
    poll = invoke('executor_pairing_status')
      .then((next) => (mine === attemptId && !busy ? finish(next) : undefined))
      .catch((error) => nc.reportError(error))
      .finally(() => { poll = null })
  }, 3000)

  nc.pairing = { open: openDialog, restore }
})()
