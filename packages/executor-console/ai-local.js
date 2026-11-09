// The AI tab's "On this computer": Claude Code and Codex, the account each is
// signed in to, and the chosen team's Make available switch (contract §12).
// Switches save when pressed. Added accounts sign in with the program's own
// sign-in, in a terminal window; this page then waits for them to show up.
window.aiLocal = (() => {
  const nc = window.nc
  const t = (key, vars) => nc.t(`aiLocal.${key}`, vars)
  const PROGRAMS = { 'claude-code': 'claude', codex: 'codex' }
  const WAIT_MS = 3_000
  const WAIT_FOR_MS = 5 * 60_000
  let request = 0
  let rows = []
  let waiting = null
  const section = document.createElement('div')
  section.id = 'ai-local'
  section.innerHTML = `
    <div class="section-heading"><div class="label-row"><h3 id="ai-local-title"></h3></div></div>
    <p class="hint" id="ai-local-service" hidden></p>
    <div id="ai-local-list"></div>
    <div class="actions" id="ai-local-add"></div>
    <p id="ai-local-error" class="field-error" role="alert" hidden></p>`
  const help = nc.help('')
  help.id = 'ai-local-hint'
  section.querySelector('#ai-local-title').after(help)
  const dialog = document.createElement('dialog')
  dialog.id = 'ai-local-dialog'
  dialog.setAttribute('aria-labelledby', 'ai-local-dialog-title')
  dialog.innerHTML = `
    <h2 id="ai-local-dialog-title"></h2>
    <form id="ai-local-form">
      <p id="ai-local-dialog-body"></p>
      <label id="ai-local-name-label" for="ai-local-name"></label>
      <input id="ai-local-name" maxlength="80" required>
      <p class="dialog-error" role="alert" hidden></p>
      <div class="actions"><button type="button" id="ai-local-cancel"></button>
        <button type="submit" id="ai-local-confirm" class="primary"></button></div>
    </form>`
  document.body.append(dialog)
  const byId = nc.byId
  const engineName = (row) => (row.name ? t('withName', { engine: t(`engines.${row.engine}`), name: row.name })
    : t(`engines.${row.engine}`))

  const detail = (row, team) => {
    if (!row.installed) return t('notInstalled')
    if (!row.signedIn) return row.profileId ? t('signedOutAccount') : t('signedOut', { program: PROGRAMS[row.engine] })
    const account = row.account ?? t('signedIn')
    if (!row.available) return account
    return `${account} · ${row.offered === 'yes' ? t('offered', { team }) : t('notYet')}`
  }

  const button = (label, name, action) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    node.setAttribute('aria-label', `${label} · ${name}`)
    node.onclick = () => nc.attempt(() => action(node), { target: node })
    return node
  }

  const render = (executorId) => {
    const team = nc.team.label(executorId)
    const list = byId('ai-local-list')
    list.replaceChildren()
    for (const row of rows) {
      const name = engineName(row)
      const node = document.createElement('div')
      node.className = 'list-row'
      if (!row.installed) node.setAttribute('aria-disabled', 'true')
      const label = document.createElement('div')
      label.className = 'list-name'
      label.textContent = name
      const small = document.createElement('small')
      small.textContent = detail(row, team)
      label.append(small)
      node.append(label)
      if (row.profileId && !row.signedIn && row.installed) {
        node.append(button(t('signIn'), name, () => signIn(executorId, row)))
      }
      if (row.profileId) node.append(button(t('remove'), name, () => confirmRemove(executorId, row)))
      node.append(window.accessTab.toggle({ label: t('switchLabel', { engine: name, team }), checked: row.available,
        disabled: !row.installed, onchange: (checked, input) => nc.attempt(() => change(executorId,
          'executor_set_local_ai', { engine: row.engine, profileId: row.profileId, available: checked }),
        { target: input }) }))
      const caption = document.createElement('span')
      caption.className = 'switch-caption'
      caption.textContent = t('makeAvailable')
      caption.setAttribute('aria-hidden', 'true')
      node.lastChild.prepend(caption)
      list.append(node)
    }
    const add = byId('ai-local-add')
    add.replaceChildren()
    for (const engine of ['claude-code', 'codex']) {
      if (!rows.some((row) => row.engine === engine && row.profileId === null && row.installed)) continue
      add.append(button(t(`add.${engine}`), t(`engines.${engine}`), () => openAdd(executorId, engine)))
    }
  }

  const show = (executorId, answer) => {
    const service = !Array.isArray(answer)
    byId('ai-local-service').hidden = !service
    rows = service ? [] : answer
    if (service) byId('ai-local-list').replaceChildren()
    else render(executorId)
    if (service) byId('ai-local-add').replaceChildren()
  }

  const retry = nc.retrying()
  /** Reads this computer's engines; a failed read tries again by itself while the AI tab shows this team. */
  const load = async () => {
    const asked = ++request
    const executorId = nc.team.current()
    for (const [id, key] of [['ai-local-title', 'title'], ['ai-local-service', 'service']]) byId(id).textContent = t(key)
    help.set(t('hint', { team: executorId ? nc.team.label(executorId) : '' }))
    byId('ai-local-error').hidden = true
    if (!executorId) return
    byId('ai-local-list').textContent = t('loading')
    try {
      const answer = await nc.invoke('executor_local_ai', { executorId })
      if (asked === request && executorId === nc.team.current()) show(executorId, answer)
      retry.succeeded()
    } catch {
      if (asked !== request) return
      byId('ai-local-list').textContent = t('failed')
      retry.failed(() => { if (nc.view.current() === 'ai' && executorId === nc.team.current()) void load() })
    }
  }

  const change = async (executorId, command, args) => {
    const answer = await nc.invoke(command, { executorId, ...args })
    if (executorId === nc.team.current()) show(executorId, answer)
    return answer
  }

  /** After a sign-in starts, check again every few seconds until that account is signed in. */
  const waitFor = (executorId, match) => {
    clearTimeout(waiting?.timer)
    const until = Date.now() + WAIT_FOR_MS
    const tick = async () => {
      if (executorId !== nc.team.current() || Date.now() > until) { waiting = null; return }
      const answer = await nc.invoke('executor_local_ai', { executorId }).catch(() => null)
      if (Array.isArray(answer)) show(executorId, answer)
      if (Array.isArray(answer) && answer.some((row) => match(row) && row.signedIn)) { waiting = null; return }
      waiting = { timer: setTimeout(tick, WAIT_MS) }
    }
    waiting = { timer: setTimeout(tick, WAIT_MS) }
  }

  const signIn = async (executorId, row) => {
    await change(executorId, 'executor_local_ai_sign_in', { profileId: row.profileId })
    waitFor(executorId, (next) => next.profileId === row.profileId)
  }

  let pending = null
  const openDialog = (state) => {
    pending = state
    byId('ai-local-dialog-title').textContent = state.title
    byId('ai-local-dialog-body').textContent = state.body
    byId('ai-local-name-label').textContent = t('name')
    byId('ai-local-name-label').hidden = !state.named
    byId('ai-local-name').hidden = !state.named
    byId('ai-local-name').required = state.named
    byId('ai-local-name').value = state.name ?? ''
    byId('ai-local-cancel').textContent = t('cancel')
    byId('ai-local-confirm').textContent = state.confirm
    byId('ai-local-confirm').className = state.danger ? 'danger' : 'primary'
    dialog.querySelector('.dialog-error').hidden = true
    dialog.lang = document.documentElement.lang
    dialog.showModal()
    if (state.named) byId('ai-local-name').select()
  }
  const openAdd = (executorId, engine) => {
    const engineWord = t(`engines.${engine}`)
    const count = rows.filter((row) => row.engine === engine).length
    openDialog({ executorId, title: t(`add.${engine}`), body: t('addBody', { engine: engineWord }), named: true,
      name: t(`accountName.${engine}`, { n: count + 1 }), confirm: t('signInWith', { engine: engineWord }),
      run: async (name) => {
        const before = new Set(rows.map((row) => row.profileId))
        const answer = await change(executorId, 'executor_local_ai_add_account', { engine, name })
        const added = Array.isArray(answer) ? answer.find((row) => row.profileId && !before.has(row.profileId)) : null
        if (added) waitFor(executorId, (next) => next.profileId === added.profileId)
      } })
  }
  const confirmRemove = (executorId, row) => {
    const name = engineName(row)
    openDialog({ executorId, title: t('removeTitle', { name }), danger: true, named: false,
      body: t('removeBody', { name, engine: t(`engines.${row.engine}`) }), confirm: t('removeConfirm'),
      run: () => change(executorId, 'executor_local_ai_remove_account', { profileId: row.profileId }) })
  }
  byId('ai-local-form').onsubmit = (event) => {
    event.preventDefault()
    const state = pending
    if (!state) return
    nc.attempt(async () => {
      for (const control of dialog.querySelectorAll('button,input')) control.disabled = true
      try {
        await state.run(byId('ai-local-name').value.trim())
        dialog.close()
      } finally { for (const control of dialog.querySelectorAll('button,input')) control.disabled = false }
    }, { target: byId('ai-local-confirm') })
  }
  byId('ai-local-cancel').onclick = () => dialog.close()
  dialog.addEventListener('close', () => { pending = null })
  nc.team.onChange(() => { clearTimeout(waiting?.timer); waiting = null })
  return { section, load }
})()
