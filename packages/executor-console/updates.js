// Software belongs to this computer, so these controls never depend on a team.
// Linux's settings page loads this section alone, beside i18n.js and native.js.
(() => {
  const nc = window.nc
  const node = (id) => document.getElementById(`update-${id}`)
  const text = (key, version) => nc.t(`updates.${key}`, { version: version ?? '' })
  let status = null
  let busy = false
  let announced = null
  const active = new Set(['downloading', 'waiting', 'installing', 'restarting'])
  const listeners = new Set()

  const render = () => {
    node('version').textContent = status?.installedVersion || text('unknown')
    node('automatic').checked = status?.automatic === true
    node('automatic').disabled = busy || !status?.canInstall
    node('policy').hidden = !status?.canInstall
    node('check').disabled = busy || status?.canInstall === false || active.has(status?.phase)
    node('setup').hidden = status?.code !== 'update.setup_required'
    node('setup').disabled = busy
    const version = status?.targetVersion ?? status?.availableVersion
    const canUpdate = status?.canInstall && status?.availableVersion && !active.has(status.phase)
    node('install').hidden = !canUpdate
    node('install').disabled = busy
    node('install').textContent = text('install', status?.availableVersion)
    node('hint').textContent = status?.automatic === false ? text('offHint') : text('automaticHint')
    const phase = status?.phase ?? 'checking'
    const known = ['idle', 'checking', 'downloading', 'waiting', 'installing', 'restarting', 'failed', 'unsupported', 'available']
    node('status').textContent = status?.code === 'update.setup_required' ? text('setupHint') : status?.code === 'update.bootstrap_required'
      ? text('bootstrap') : text(known.includes(phase) ? phase : 'unavailable', version)
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
  node('setup').textContent = text('setup')
  node('prompt-title').textContent = text('promptTitle')
  node('prompt-remind').textContent = text('remind')
  node('prompt-hint').textContent = text('automaticHint')
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
  }
})()
