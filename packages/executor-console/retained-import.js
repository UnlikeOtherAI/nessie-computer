// This local surface reviews queued tuples; opening it never approves anything.
// Source-owner approval and the browser's fresh UOA key enrollment are separate.
;(async () => {
  if (window.executorNative.platform !== 'windows') return
  const words = await fetch('retained-import-words.json').then(response => response.json())
  const language = (navigator.language || 'en').split('-')[0]
  const w = words[language] || words.en
  const node = id => document.getElementById(`retained-${id}`)
  const section = document.getElementById('retained-import')
  node('title').textContent = w.title
  node('baseline').textContent = w.baseline
  node('root-label').textContent = w.root
  node('offer').textContent = w.offer
  node('refresh').textContent = w.refresh
  node('revoke').textContent = w.revoke
  section.hidden = false
  let selected = null
  let busy = false
  const executor = () => document.getElementById('connection').value
  const invoke = (command, args) => window.executorNative.invoke(command, args)
  const attempt = async action => {
    if (busy) return
    busy = true
    node('error').hidden = true
    try { await action() } catch { node('error').textContent = w.error; node('error').hidden = false }
    finally { busy = false }
  }
  const refresh = async () => {
    const executorId = executor()
    node('requests').replaceChildren()
    node('root').replaceChildren()
    node('status').textContent = ''
    node('revoke').hidden = true
    selected = executorId
    if (!executorId) return
    const data = await invoke('executor_retained_status', { executorId })
    if (executor() !== executorId) return
    for (const root of data.roots) {
      const option = document.createElement('option')
      option.value = root.admittedRootKey
      option.textContent = root.admittedRootKey
      node('root').append(option)
    }
    const requests = [...data.pending.enrollments.map(challenge => ({ action: 'enroll', challenge })),
      ...data.pending.imports.map(challenge => ({ action: 'approve', challenge }))]
    for (const { action, challenge } of requests) {
      const row = document.createElement('section')
      const recipient = document.createElement('pre')
      // Text nodes only: IDs and exact ordered source selection are data.
      recipient.textContent = JSON.stringify({ environmentId: challenge.environmentId,
        recipient: challenge.recipient, selection: challenge.selection,
        acceptedBaseline: 'not_attested_by_original_source' }, null, 2)
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = w[action]
      button.onclick = () => attempt(async () => {
        if (executor() !== executorId) return
        // Revoke remains available while Windows is showing the secure prompt.
        node('revoke').hidden = false
        await invoke('executor_retained_action', { executorId, action,
          id: action === 'enroll' ? challenge.enrollmentId : challenge.challengeId })
        await refresh()
      })
      row.append(recipient, button)
      node('requests').append(row)
    }
    node('status').textContent = data.active ? w.active : requests.length ? '' : w.empty
    node('revoke').hidden = !data.active
    node('offer').disabled = !data.roots.length
  }
  node('refresh').onclick = () => attempt(refresh)
  node('offer').onclick = () => attempt(async () => {
    const executorId = executor()
    if (!executorId || selected !== executorId || !node('root').value) return
    await invoke('executor_retained_action', { executorId, action: 'offer', id: node('root').value })
    await refresh()
  })
  node('revoke').onclick = async () => {
    try {
      await invoke('executor_retained_action', { executorId: selected, action: 'revoke', id: '' })
      node('revoke').hidden = true
      node('status').textContent = ''
    } catch { node('error').textContent = w.error; node('error').hidden = false }
  }
  // Changing teams clears the prior team's display. Loading is an explicit action.
  document.getElementById('connection').addEventListener('change', () => {
    selected = null
    node('requests').replaceChildren(); node('root').replaceChildren()
    node('status').textContent = ''; node('revoke').hidden = true
  })
})().catch(() => { /* No language bundle means no consent surface. */ })
