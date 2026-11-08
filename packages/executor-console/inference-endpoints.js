let endpointExecutor = null
let endpointId = null
let endpointBusy = false
const endpointDialog = byId('endpoint-dialog')
for (const [id, key] of [['title', 'endpointTitle'], ['name-label', 'name'], ['address-label', 'address'],
  ['scope-label', 'scope'], ['local', 'local'], ['network', 'network'], ['key-label', 'key'], ['key-hint', 'keyHint'],
  ['clear-key-copy', 'clearKey'], ['remove', 'remove'], ['close', 'close'], ['save', 'save']]) {
  byId(`endpoint-${id}`).textContent = aiWords[key]
}
const openInferenceEndpoint = (endpoint) => {
  if (!currentExecutorId) return
  endpointExecutor = currentExecutorId
  endpointId = endpoint?.id ?? crypto.randomUUID()
  byId('endpoint-name').value = endpoint?.name ?? ''
  byId('endpoint-address').value = endpoint?.baseUrl ?? ''
  byId('endpoint-scope').value = endpoint?.scope ?? 'local'
  byId('endpoint-key').value = ''
  byId('endpoint-clear-key').checked = false
  byId('endpoint-clear-key-row').hidden = !endpoint?.hasApiKey
  byId('endpoint-remove').hidden = !endpoint
  clearErrors()
  endpointDialog.showModal()
  byId('endpoint-name').focus()
}
const changeEndpoint = async (operation) => {
  if (endpointBusy || !endpointExecutor) return
  endpointBusy = true
  for (const control of endpointDialog.querySelectorAll('button,input,select')) control.disabled = true
  clearErrors()
  try {
    await invoke('executor_inference_connections', { executorId: endpointExecutor, operation })
    endpointDialog.close()
    await loadAi()
  } catch { reportError(aiWords.changeFailed) }
  finally {
    endpointBusy = false
    for (const control of endpointDialog.querySelectorAll('button,input,select')) control.disabled = false
  }
}
byId('endpoint-form').onsubmit = event => {
  event.preventDefault()
  const key = byId('endpoint-key').value
  return changeEndpoint({ operation: 'save', id: endpointId, name: byId('endpoint-name').value.trim(),
    baseUrl: byId('endpoint-address').value.trim(), scope: byId('endpoint-scope').value,
    ...(key || byId('endpoint-clear-key').checked ? { apiKey: key } : {}) })
}
byId('endpoint-remove').onclick = () => changeEndpoint({ operation: 'remove', id: endpointId })
endpointDialog.addEventListener('cancel', event => { if (endpointBusy) event.preventDefault() })
endpointDialog.addEventListener('close', () => {
  byId('endpoint-key').value = ''
  endpointExecutor = null
})
