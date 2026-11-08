// One home for every local AI connection, scoped to the selected paired team.
const aiWords = window.aiConsoleWords
let aiRequest = 0
let aiEndpoints = []
const aiRow = (name, detail, id, manage) => {
  const row = document.createElement('div')
  row.className = 'connection-row'
  const label = document.createElement('div')
  label.className = 'connection-name'
  label.textContent = name
  const status = document.createElement('small')
  status.textContent = detail
  label.append(status)
  const button = document.createElement('button')
  button.textContent = aiWords.manage
  button.setAttribute('aria-label', `${aiWords.manage} · ${name}`)
  button.dataset.key = id
  button.onclick = () => attempt(manage)
  row.append(label, button)
  return row
}
const loadAi = async () => {
  const asked = ++aiRequest
  const executorId = currentExecutorId
  aiEndpoints = []
  for (const id of ['ai-chatgpt-list', 'ai-endpoint-list']) byId(id).textContent = aiWords.loading
  byId('ai-error').hidden = true
  if (!executorId) return
  const results = await Promise.allSettled([
    invoke('executor_personal_chatgpt', { executorId, operation: { operation: 'status' } }),
    invoke('executor_inference_connections', { executorId, operation: { operation: 'status' } }),
  ])
  if (asked !== aiRequest || executorId !== currentExecutorId) return
  const [accounts, endpoints] = results
  const accountList = byId('ai-chatgpt-list')
  accountList.replaceChildren()
  if (accounts.status === 'fulfilled') {
    for (const [index, profile] of accounts.value.profiles.entries()) {
      accountList.append(aiRow(profile.label ?? `ChatGPT ${index + 1}`,
        chatgptWords.phases[profile.phase], profile.profileId, () => openChatgpt(executorId, profile.profileId)))
    }
    if (!accounts.value.profiles.length) accountList.textContent = accounts.value.reason
      ? chatgptWords.unavailable[accounts.value.reason] ?? chatgptWords.unavailable.other : aiWords.emptyChatgpt
  } else accountList.textContent = chatgptWords.failed
  const endpointList = byId('ai-endpoint-list')
  endpointList.replaceChildren()
  if (endpoints.status === 'fulfilled') {
    aiEndpoints = endpoints.value.endpoints
    for (const endpoint of aiEndpoints) {
      endpointList.append(aiRow(endpoint.name,
        `${aiWords[endpoint.status]} · ${endpoint.baseUrl} · ${endpoint.models.join(', ') || aiWords.noModels}`,
        endpoint.id, () => openInferenceEndpoint(endpoint)))
    }
    if (!aiEndpoints.length) endpointList.textContent = aiWords.emptyEndpoints
  } else endpointList.textContent = aiWords.failed
}
for (const [id, key] of [['ai-add-chatgpt', 'addChatgpt'], ['ai-endpoints-title', 'endpointsTitle'],
  ['ai-add-endpoint', 'addEndpoint'], ['ai-endpoints-hint', 'endpointsHint'], ['ai-refresh', 'refresh']]) {
  byId(id).textContent = aiWords[key]
}
byId('ai-add-chatgpt').onclick = () => attempt(() => openChatgpt(currentExecutorId, null, true))
byId('ai-add-endpoint').onclick = () => openInferenceEndpoint(null)
byId('ai-refresh').onclick = () => attempt(loadAi)
