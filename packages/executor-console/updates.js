// Software belongs to this computer, so these controls never depend on a team.
// Linux's settings page loads this section alone, beside i18n.js and native.js.
(() => {
  const nc = window.nc
  const node = (id) => document.getElementById(`update-${id}`)
  const text = (key, version) => nc.t(`updates.${key}`, { version: version ?? '' })
  // macOS's own short reason for refusing the helper's registration.
  const cantStart = () => nc.t('updates.cantStart', { reason: status?.reason ?? '' })
  let status = null
  let busy = false
  let announced = null
  const active = new Set(['downloading', 'waiting', 'installing', 'restarting'])
  const listeners = new Set()
  // What automatic updates do sits behind "?" beside the switch; its words follow the switch.
  const automaticHelp = nc.help(text('automaticHint'), { describes: node('automatic') })
  automaticHelp.id = 'update-hint'
  node('automatic-label').after(automaticHelp)

  const render = () => {
    node('version').textContent = status?.installedVersion || text('unknown')
    node('automatic').checked = status?.automatic === true
    node('automatic').disabled = busy || !status?.canInstall
    node('policy').hidden = !status?.canInstall
    node('check').disabled = busy || status?.canInstall === false || active.has(status?.phase)
    // One action for each: set the helper up, open Login Items for one macOS
    // holds back, restart one that is stuck, or register again one macOS refused.
    const stuck = status?.code === 'update.helper_unavailable'
    const approval = status?.code === 'update.approval_required'
    const refused = status?.code === 'update.registration_failed'
    node('setup').hidden = status?.code !== 'update.setup_required' && !stuck && !approval && !refused
    node('setup').disabled = busy
    node('setup').textContent = text(approval ? 'openLoginItems' : stuck ? 'restart' : refused ? 'tryAgain' : 'setup')
    const version = status?.targetVersion ?? status?.availableVersion
    const canUpdate = status?.canInstall && status?.availableVersion && !active.has(status.phase)
    node('install').hidden = !canUpdate
    node('install').disabled = busy
    node('install').textContent = text('install', status?.availableVersion)
    automaticHelp.set(status?.automatic === false ? text('offHint') : text('automaticHint'))
    const phase = status?.phase ?? 'checking'
    const known = ['idle', 'checking', 'downloading', 'waiting', 'installing', 'restarting', 'failed', 'unsupported', 'available']
    node('status').textContent = status?.code === 'update.setup_required' ? text('setupHint') : stuck ? text('helperStuck')
      : approval ? text('approval') : refused ? cantStart()
      : status?.code === 'update.bootstrap_required' ? text('bootstrap') : text(known.includes(phase) ? phase : 'unavailable', version)
    if (phase === 'failed' && status?.availableVersion) node('status').textContent += ` ${text('available', status.availableVersion)}`
    if (!status?.notify || status.automatic || !canUpdate) announced = null
    for (const listener of listeners) listener(status)
  }

  const offer = () => {
    if (!status?.notify || status.automatic || !status.canInstall || !status.availableVersion
      || active.has(status.phase) || announced === status.availableVersion) return
    // Do not obscure another decision, such as connecting a team or signing in.
    if (document.querySelector('dialog[open]')) return
    announced = status.availableVersion
    node('prompt-body').textContent = text('promptBody', status.availableVersion)
    node('prompt-install').textContent = text('install', status.availableVersion)
    node('dialog').showModal()
    node('prompt-install').focus()
  }

  const load = async (request = { operation: 'status' }) => {
    if (busy) return
    busy = true
    render()
    node('error').hidden = node('prompt-error').hidden = true
    try {
      const next = request.operation === 'setup'
        ? await window.executorNative.invoke('executor_update_setup')
        : await window.executorNative.invoke('executor_update_control', { request })
      if (!next || typeof next.installedVersion !== 'string' || typeof next.canInstall !== 'boolean') throw new Error('invalid update status')
      status = next
      if (request.operation === 'install' || request.operation === 'remind') node('dialog').close()
    } catch {
      for (const id of ['error', 'prompt-error']) {
        node(id).textContent = text('unavailable')
        node(id).hidden = false
      }
      // A service failure must not silently change a saved automatic-update choice.
    } finally {
      busy = false
      render()
      if (!status) node('status').textContent = text('unavailable')
      offer()
    }
  }

  node('title').textContent = text('title')
  node('version-label').textContent = text('installed')
  node('automatic-label').textContent = text('automatic')
  node('check').textContent = text('check')
  node('prompt-title').textContent = text('promptTitle')
  node('prompt-remind').textContent = text('remind')
  node('check').onclick = () => load({ operation: 'check' })
  node('setup').onclick = () => load({ operation: 'setup' })
  node('install').onclick = node('prompt-install').onclick = () => load({ operation: 'install' })
  node('automatic').onchange = () => load({ operation: 'automatic', enabled: node('automatic').checked })
  node('prompt-remind').onclick = () => load({ operation: 'remind' })
  // Escape means the same durable 24-hour reminder as its labelled button.
  node('dialog').addEventListener('cancel', (event) => { event.preventDefault(); load({ operation: 'remind' }) })
  window.executorNative.listen('executor://update-available', () => load())
  window.addEventListener('DOMContentLoaded', () => {
    load()
    setInterval(() => load(), 15_000)
  })
  nc.updates = {
    onStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    status: () => status,
    /** The helper can't be reached or refuses, so no team can start. */
    stuck: () => status?.code === 'update.helper_unavailable',
    /** macOS won't run the helper until the owner allows it in Login Items. */
    approval: () => status?.code === 'update.approval_required',
    /** macOS refused to register the helper; the line says why. */
    refused: () => status?.code === 'update.registration_failed',
    cantStart,
    restart: () => load({ operation: 'setup' }),
    approve: () => load({ operation: 'setup' }),
    retry: () => load({ operation: 'setup' }),
  }
})()
