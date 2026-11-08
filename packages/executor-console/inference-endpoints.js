// The model server dialog: one OpenAI-compatible server on this computer or
// the local network, saved for the chosen team. Keys travel once, on save,
// and never come back to the page.
window.inferenceEndpoints = (() => {
  const nc = window.nc
  const t = (key) => nc.t(`ai.${key}`)
  let executor = null
  let endpointId = null
  let busy = false
  const dialog = document.createElement('dialog')
  dialog.id = 'endpoint-dialog'
  dialog.setAttribute('aria-labelledby', 'endpoint-title')
  dialog.innerHTML = `
    <h2 id="endpoint-title"></h2>
    <form id="endpoint-form">
      <label id="endpoint-name-label" for="endpoint-name"></label>
      <input id="endpoint-name" maxlength="80" required>
      <label id="endpoint-address-label" for="endpoint-address"></label>
      <input id="endpoint-address" type="url" maxlength="512" required placeholder="http://192.168.1.90:8080/v1">
      <label id="endpoint-scope-label" for="endpoint-scope"></label>
      <select id="endpoint-scope"><option value="local" id="endpoint-local"></option><option value="network" id="endpoint-network"></option></select>
      <label id="endpoint-key-label" for="endpoint-key"></label>
      <input id="endpoint-key" type="password" maxlength="4096" autocomplete="new-password">
      <p id="endpoint-key-hint" class="hint"></p>
      <label class="toggle" id="endpoint-clear-key-row" hidden><input id="endpoint-clear-key" type="checkbox"><span id="endpoint-clear-key-copy"></span></label>
      <p class="dialog-error" role="alert" hidden></p>
      <div class="actions"><button type="button" id="endpoint-remove" class="danger" hidden></button><button type="button" id="endpoint-close"></button><button type="submit" id="endpoint-save" class="primary"></button></div>
    </form>`
  document.body.append(dialog)
  const byId = nc.byId
  const open = (endpoint) => {
    const executorId = nc.team.current()
    if (!executorId) return
    executor = executorId
    endpointId = endpoint?.id ?? crypto.randomUUID()
    for (const [id, key] of [['title', 'serverTitle'], ['name-label', 'name'], ['address-label', 'address'], ['scope-label', 'scope'],
      ['local', 'local'], ['network', 'network'], ['key-label', 'key'], ['key-hint', 'keyHint'], ['clear-key-copy', 'clearKey'],
      ['remove', 'remove'], ['close', 'close'], ['save', 'save']]) byId(`endpoint-${id}`).textContent = t(key)
    byId('endpoint-name').value = endpoint?.name ?? ''
    byId('endpoint-address').value = endpoint?.baseUrl ?? ''
    byId('endpoint-scope').value = endpoint?.scope ?? 'local'
    byId('endpoint-key').value = ''
    byId('endpoint-clear-key').checked = false
    byId('endpoint-clear-key-row').hidden = !endpoint?.hasApiKey
    byId('endpoint-remove').hidden = !endpoint
    dialog.querySelector('.dialog-error').hidden = true
    dialog.lang = document.documentElement.lang
    dialog.showModal()
    byId('endpoint-name').focus()
  }
  const change = (operation) => nc.attempt(async () => {
    if (busy || !executor) return
    busy = true
    for (const control of dialog.querySelectorAll('button,input,select')) control.disabled = true
    try {
      await nc.invoke('executor_inference_connections', { executorId: executor, operation })
      dialog.close()
      await window.aiTab.load()
    } catch { throw new Error(t('changeFailed')) } finally {
      busy = false
      for (const control of dialog.querySelectorAll('button,input,select')) control.disabled = false
    }
  }, { target: byId('endpoint-save') })
  byId('endpoint-form').onsubmit = (event) => {
    event.preventDefault()
    const key = byId('endpoint-key').value
    return change({ operation: 'save', id: endpointId, name: byId('endpoint-name').value.trim(),
      baseUrl: byId('endpoint-address').value.trim(), scope: byId('endpoint-scope').value,
      ...(key || byId('endpoint-clear-key').checked ? { apiKey: key } : {}) })
  }
  byId('endpoint-remove').onclick = () => change({ operation: 'remove', id: endpointId })
  byId('endpoint-close').onclick = () => dialog.close()
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault() })
  dialog.addEventListener('close', () => {
    byId('endpoint-key').value = ''
    executor = null
  })
  return { open }
})()
