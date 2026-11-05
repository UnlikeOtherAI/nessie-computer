let pairingView = null
let pairingBusy = false
let pairingPoll = null
// Each attempt has a number; an answer for an attempt that was cancelled is ignored.
let pairingAttempt = 0
const windowsPlanChoice = window.executorNative.platform === 'windows'
let pairingPersonalPlan = false
try { pairingPersonalPlan = windowsPlanChoice && localStorage.getItem('nessie.pending-personal-plan-pairing') === '1' } catch {}
byId('pairing-personal-plan-choice').hidden = !windowsPlanChoice
byId('pairing-personal-plan').checked = pairingPersonalPlan
byId('pairing-default-folders').hidden = pairingPersonalPlan
byId('pairing-personal-plan-label').textContent = window.executorPairingWords.label
byId('pairing-personal-plan-hint').textContent = window.executorPairingWords.hint
byId('pairing-personal-plan').onchange = (event) => {
  pairingPersonalPlan = event.target.checked
  byId('pairing-default-folders').hidden = pairingPersonalPlan
}
const pairingInvoke = (command, args = {}) => invoke(command,
  windowsPlanChoice ? { ...args, personalPlanConnection: pairingPersonalPlan } : args)
const resetPairingChoice = () => {
  pairingPersonalPlan = false
  byId('pairing-personal-plan').checked = false
  byId('pairing-default-folders').hidden = false
  try { localStorage.removeItem('nessie.pending-personal-plan-pairing') } catch {}
}
const pairingOpen = (view) => ['waiting', 'expired'].includes(view?.status)
const pairingActions = ['pairing-form-cancel', 'pairing-open-nessie', 'pairing-stop', 'pairing-renew', 'copy-code',
  'pairing-personal-plan']
const secondsLeft = () => Math.max(0, Math.ceil((Date.parse(pairingView?.expiresAt ?? '') - Date.now()) / 1000) || 0)
const announcePairing = (text) => { byId('pairing-announce').textContent = text }

// A code that runs out while shown is treated as expired.
const pairingExpired = (view) => view?.status === 'expired'
  || (view?.status === 'waiting' && Boolean(view.expiresAt) && Date.parse(view.expiresAt) <= Date.now())
let pairingStep = null
const renderPairing = (view) => {
  const expired = pairingExpired(view)
  const step = expired ? 'expired' : view.status
  const stepChanged = step !== pairingStep
  pairingStep = step
  pairingView = view
  const open = pairingOpen(view)
  byId('pair-form').hidden = open
  byId('pairing-progress').hidden = !open
  byId('pairing-code').textContent = view.status === 'waiting' ? view.code ?? '' : ''
  byId('code-row').hidden = view.status !== 'waiting' || expired
  byId('copy-code').textContent = 'Copy'
  byId('pairing-instruction').textContent = expired ? 'This code has expired.'
    : view.status === 'waiting' ? 'In Nessie, select the team you want to connect, then open Admin › Computers › '
      + 'Pair a computer and paste this code. This computer connects as soon as Nessie accepts it.' : ''
  byId('pairing-fingerprint-block').hidden = !view.fingerprint || expired
  byId('pairing-fingerprint').textContent = view.fingerprint ?? ''
  byId('pairing-renew').hidden = !expired
  byId('pairing-open-nessie').hidden = view.status !== 'waiting' || expired
  updatePairingTime()
  if (open && stepChanged && byId('pair-dialog').open) {
    byId('pairing-title').focus()
    announcePairing(byId('pairing-instruction').textContent)
  }
}

// The countdown is quiet for screen readers; only step changes are announced.
const updatePairingTime = () => {
  const counting = pairingView?.status === 'waiting' && secondsLeft() > 0
  const seconds = secondsLeft()
  byId('pairing-time').textContent = counting ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''
  // A code that runs out while shown turns into the expired step once.
  if (pairingStep !== 'expired' && pairingExpired(pairingView)) renderPairing(pairingView)
  if (!pairingBusy) for (const id of pairingActions) byId(id).disabled = false
}

/** An attempt left open when the app last closed reopens its dialog. */
const restorePairing = async () => {
  const view = await pairingInvoke('executor_pairing_status')
  renderPairing(view)
  if (pairingOpen(view)) byId('pair-dialog').showModal()
  return view
}

const openPairDialog = async () => {
  await showTab('teams')
  clearErrors()
  if (!pairingOpen(pairingView)) renderPairing({ status: 'idle' })
  if (!byId('pair-dialog').open) byId('pair-dialog').showModal()
  if (!pairingOpen(pairingView)) byId('pairing-server').focus()
}

/**
 * The person's claim in Nessie finishes the pairing, so the first status that
 * reads `paired` closes the dialog and says which team took this computer.
 * That team is now selected in Teams, where Remove undoes it.
 */
const finishPairing = async (view) => {
  renderPairing(view)
  if (view.status !== 'paired') return
  resetPairingChoice()
  byId('pair-dialog').close()
  await refresh()
  if (view.executorId) await selectTeam(view.executorId)
  const destination = [view.organizationName, view.teamName].filter(Boolean).join(', ') || 'the team'
  await notify('Connected', `Connected to ${destination}. If you didn’t expect this, remove the team in Teams.`)
}

/**
 * One pairing request at a time. The pressed button says what is happening,
 * every other action waits, and neither the countdown nor polling can re-enable
 * them meanwhile.
 */
const runPairing = (button, pendingLabel, action) => attempt(async () => {
  const label = button.textContent
  const attemptId = pairingAttempt
  pairingBusy = true
  for (const id of pairingActions) byId(id).disabled = true
  button.disabled = true
  button.textContent = pendingLabel
  try {
    // A status check already on its way finishes first; two requests never race.
    await pairingPoll
    const view = await action()
    if (view && attemptId === pairingAttempt) await finishPairing(view)
  } finally {
    pairingBusy = false
    button.disabled = false
    button.textContent = label
    updatePairingTime()
  }
})

const startPairing = (button, apiBaseUrl) => runPairing(button, 'Getting code…', () => {
  try { localStorage.setItem('nessie.pending-personal-plan-pairing', pairingPersonalPlan ? '1' : '0') } catch {}
  return pairingInvoke('executor_pairing_start', { replace: false, apiBaseUrl })
})

const cancelPairing = (button) => runPairing(button, 'Cancelling…', async () => {
  pairingAttempt += 1
  renderPairing(await pairingInvoke('executor_pairing_cancel'))
  resetPairingChoice()
  byId('pair-dialog').close()
  await refresh()
})

byId('pair-form').onsubmit = (event) => {
  event.preventDefault()
  byId('pairing-server').removeAttribute('aria-invalid')
  startPairing(byId('pair-form').querySelector('[type=submit]'), byId('pairing-server').value)
}
byId('copy-code').onclick = () => attempt(async () => {
  if (pairingView?.status !== 'waiting' || secondsLeft() === 0) return
  await invoke('executor_copy_code', { code: pairingView.code })
  byId('copy-code').textContent = 'Copied'
  announcePairing('Pairing code copied.')
})
byId('pairing-open-nessie').onclick = () => attempt(() => invoke('executor_open_nessie', {
  apiBaseUrl: pairingView?.apiBaseUrl ?? byId('pairing-server').value,
}))
byId('pairing-stop').onclick = () => cancelPairing(byId('pairing-stop'))
byId('pairing-renew').onclick = () => {
  const server = pairingView?.apiBaseUrl ?? byId('pairing-server').value
  runPairing(byId('pairing-renew'), 'Getting code…', async () => {
    // A pairing Nessie already accepted is finished, not replaced.
    const current = await pairingInvoke('executor_pairing_status')
    if (current.status === 'paired') return current
    await pairingInvoke('executor_pairing_cancel')
    return pairingInvoke('executor_pairing_start', { replace: false, apiBaseUrl: server })
  })
}
// Escape during an attempt cancels it, rather than hiding a code that stays valid.
byId('pair-dialog').addEventListener('cancel', (event) => {
  if (pairingBusy) { event.preventDefault(); return }
  if (!pairingOpen(pairingView)) return
  event.preventDefault()
  cancelPairing(byId('pairing-stop'))
})
setInterval(updatePairingTime, 1000)
setInterval(() => {
  // Checks continue after the code runs out here: a claim made just before expiry still completes.
  if (pairingBusy || pairingPoll || !byId('pair-dialog').open || pairingView?.status !== 'waiting') return
  const attemptId = pairingAttempt
  pairingPoll = pairingInvoke('executor_pairing_status')
    .then((view) => (attemptId === pairingAttempt && !pairingBusy ? finishPairing(view) : undefined))
    .catch(reportError)
    .finally(() => { pairingPoll = null })
}, 3000)
