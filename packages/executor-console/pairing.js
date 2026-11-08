// Connect a team. Opening the dialog asks Nessie for a code straight away;
// the person types it in Nessie under Computers › Add a computer, and the
// claim there finishes the pairing. The computer asks nothing else.
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
  const server = () => view?.apiBaseUrl ?? byId('pairing-server').value ?? DEFAULT_SERVER

  const render = (next) => {
    const gone = expired(next)
    const nextStep = gone ? 'expired' : next.status
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
    byId('pairing-renew').hidden = !gone
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
   * `paired` closes the dialog, selects the team and shows the connected card.
   */
  const finish = async (next) => {
    render(next)
    if (next.status !== 'paired') return
    byId('connect-dialog').close()
    await nc.team.refresh()
    if (next.executorId) {
      nc.team.select(next.executorId)
      nc.overview.connected(next.executorId)
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

  const start = (apiBaseUrl, button, target) => run(button, t('pairing.getting'), async () => {
    render({ status: 'getting' })
    try {
      return await invoke('executor_pairing_start', { replace: false, apiBaseUrl })
    } catch (error) {
      render({ status: 'idle' })
      byId('connect-advanced').open = true
      throw error
    }
  }, target)

  const cancel = (button) => run(button, t('shell.cancel'), async () => {
    attemptId += 1
    render(await invoke('executor_pairing_cancel'))
    byId('connect-dialog').close()
    await nc.team.refresh()
  })

  /** Opens the dialog and asks for a code at once, unless a code is already waiting. */
  const openDialog = async () => {
    byId('pairing-server').value = view?.apiBaseUrl ?? DEFAULT_SERVER
    byId('connect-advanced').open = false
    nc.dialogs.open('connect-dialog')
    if (open(view)) { render(view); return }
    await start(DEFAULT_SERVER, null, 'pairing-server')
  }
  /** An attempt left open when the app last closed reopens its dialog. */
  const restore = async () => {
    const next = await invoke('executor_pairing_status')
    render(next)
    if (open(next)) nc.dialogs.open('connect-dialog')
    return next
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
  byId('pairing-server-hint').textContent = t('pairing.serverHint')
  byId('pairing-server-use').textContent = t('pairing.useServer')

  byId('pairing-server-use').onclick = () => {
    const address = byId('pairing-server').value.trim()
    run(byId('pairing-server-use'), t('pairing.getting'), async () => {
      // A code already waiting for another server is cancelled before this one is asked.
      if (open(view) && view.apiBaseUrl !== address) { attemptId += 1; await invoke('executor_pairing_cancel') }
      try { return await invoke('executor_pairing_start', { replace: false, apiBaseUrl: address }) } catch (error) {
        render({ status: 'idle' })
        throw error
      }
    }, 'pairing-server')
  }
  byId('copy-code').onclick = () => attempt(async () => {
    if (view?.status !== 'waiting' || secondsLeft() === 0) return
    await invoke('executor_copy_code', { code: view.code })
    byId('copy-code').textContent = t('pairing.copied')
    announce(t('pairing.announceCopied'))
  })
  byId('pairing-open-nessie').onclick = () => attempt(() => invoke('executor_open_nessie', {
    apiBaseUrl: server(), path: `/admin/computers?create=1&code=${encodeURIComponent(view?.code ?? '')}`,
  }))
  byId('pairing-stop').onclick = () => cancel(byId('pairing-stop'))
  byId('pairing-renew').onclick = () => {
    const address = server()
    run(byId('pairing-renew'), t('pairing.getting'), async () => {
      // A pairing Nessie already accepted is finished, not replaced.
      const current = await invoke('executor_pairing_status')
      if (current.status === 'paired') return current
      await invoke('executor_pairing_cancel')
      return invoke('executor_pairing_start', { replace: false, apiBaseUrl: address })
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
