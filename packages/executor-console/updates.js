// Software belongs to this computer, so these controls never depend on a team.
(() => {
  const words = window.executorUpdateWords
  const node = (id) => document.getElementById(`update-${id}`)
  const text = (key, version) => words[key].replaceAll('{version}', version ?? '')
  let status = null
  let busy = false
  let announced = null
  const active = new Set(['downloading', 'waiting', 'installing', 'restarting'])

  const render = () => {
    node('version').textContent = status?.installedVersion || words.unknown
    node('automatic').checked = status?.automatic === true
    node('automatic').disabled = busy || !status?.canInstall
    node('policy').hidden = !status?.canInstall
    node('check').disabled = busy || status?.canInstall === false || active.has(status?.phase)
    const version = status?.targetVersion ?? status?.availableVersion
    const canUpdate = status?.canInstall && status?.availableVersion && !active.has(status.phase)
    node('install').hidden = !canUpdate
    node('install').disabled = busy
    node('install').textContent = text('install', status?.availableVersion)
    node('hint').textContent = status?.automatic === false ? words.offHint : words.automaticHint
    const phase = status?.phase ?? 'checking'
    node('status').textContent = status?.code === 'update.bootstrap_required'
      ? words.bootstrap : text(words[phase] ? phase : 'unavailable', version)
    if (phase === 'failed' && status?.availableVersion) {
      node('status').textContent += ` ${text('available', status.availableVersion)}`
    }
    if (!status?.notify || status.automatic || !canUpdate) announced = null
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
      const next = await window.executorNative.invoke('executor_update_control', { request })
      if (!next || typeof next.installedVersion !== 'string' || typeof next.canInstall !== 'boolean') {
        throw new Error('invalid update status')
      }
      status = next
      if (request.operation === 'install' || request.operation === 'remind') node('dialog').close()
    } catch {
      for (const id of ['error', 'prompt-error']) {
        node(id).textContent = words.unavailable
        node(id).hidden = false
      }
      // A service failure must not silently change a saved automatic-update choice.
    } finally {
      busy = false
      render()
      if (!status) node('status').textContent = words.unavailable
      offer()
    }
  }

  node('title').textContent = words.title
  node('version-label').textContent = words.installed
  node('automatic-label').textContent = words.automatic
  node('check').textContent = words.check
  node('prompt-title').textContent = words.promptTitle
  node('prompt-remind').textContent = words.remind
  node('prompt-hint').textContent = words.automaticHint
  node('check').onclick = () => load({ operation: 'check' })
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
})()
