// The Documents tab: a copy of the chosen team's documents on this computer.
// Everything it shows comes from `sync status --json` (FolderSyncConsoleState);
// every change is a FolderSyncConsoleCommand the CLI checks and answers with a
// FolderSyncConsoleCommandResult. Changes save as they are made, in the same
// queue as every other save, so a change never overtakes one still running.
(() => {
  const nc = window.nc
  const words = window.documentsWords
  const native = window.executorNative
  const t = (key, vars) => words.text(key, vars)
  /** Refusals about the chosen folder are shown under it; the rest beside the control that asked. */
  const FOLDER_REFUSALS = new Set(['root_not_absolute', 'root_missing', 'root_not_a_directory', 'root_is_link',
    'root_not_writable', 'root_overlaps_workspace_folder', 'root_inside_state_directory', 'root_inside_other_sync', 'not_private'])
  const TONES = { up_to_date: 'ok', syncing: 'busy', starting: 'busy', waiting_for_confirmation: 'wait',
    needs_reauthorization: 'warn', root_missing: 'warn', disk_full: 'warn', needs_attention: 'warn' }

  let view = null // { executorId, state }
  let failed = null // { executorId, message }
  let switchPending = null // { executorId, enabled }
  let refusal = null // { executorId, reason }
  let existing = null // { executorId, command, saved }
  let deletedFor = null
  let request = 0
  let painted = ''
  let savedTimer = null
  const busy = new Set()
  const tab = nc.byId('tab-documents')
  const byId = nc.byId

  const stateOf = (executorId) => (view?.executorId === executorId ? view.state : null)
  const shown = () => nc.view.current() === 'documents' && Boolean(nc.team.current())
  const pending = (state) => state.counts.pendingUploads + state.counts.pendingDownloads
  const asksForDecision = (state) => state.conflicts.length > 0 || state.heldDeletes !== null
    || state.counts.openConflicts + state.counts.heldDeletes + state.counts.errors > 0

  /** The status line never says Up to date while anything is pending, waiting or in conflict. */
  const statusKey = (state) => {
    if (state.state === 'not_private') return 'not_private'
    if (!state.enabled) return 'off'
    if (state.paused) return 'paused'
    if (state.state !== 'up_to_date' && state.state !== 'syncing') return state.state
    const settled = pending(state) + state.counts.waiting === 0 && !asksForDecision(state)
    if (state.state === 'up_to_date' && settled) return 'up_to_date'
    return asksForDecision(state) && pending(state) === 0 ? 'needs_attention' : 'syncing'
  }

  const style = document.createElement('style')
  style.textContent = `
    .documents-heading #documents-switch { font-size: 15px; justify-content: space-between; align-items: flex-start; }
    #documents-switch-label { flex: 1 1 auto; min-width: 0; }
    #documents-switch .track { flex-shrink: 0; margin-top: 1px; }
    .documents-status { margin: 4px 0 12px; }
    .documents-state { display: flex; align-items: center; gap: 8px; margin: 0; font-weight: 600; }
    .documents-status .hint { margin: 2px 0 0 18px; }
    .documents-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: var(--control); }
    .documents-dot[data-tone=ok] { background: var(--on); } .documents-dot[data-tone=busy] { background: var(--accent); }
    .documents-dot[data-tone=wait] { background: var(--wait); } .documents-dot[data-tone=warn] { background: var(--error); }
    #documents-folder-label { margin-top: 16px; }
    .documents-folder-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
    .documents-folder-row .path { flex: 1 1 220px; margin: 0; font-size: 13px; color: var(--text); }
    .documents-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .documents-actions button, #documents-choose { min-height: 36px; }
    .documents-block { background: var(--soft); border-radius: 8px; padding: 12px 14px; margin-top: 18px; }
    #documents-held h3, #documents-conflicts h3 { font-size: 14px; margin: 0 0 6px; }
    #documents-conflicts { margin-top: 18px; } #documents-held .documents-actions { margin-bottom: 0; }
    .documents-paths { margin: 6px 0; padding-left: 18px; font-size: 12px; overflow-wrap: anywhere; }
    .documents-conflict { padding: 10px 0; border-bottom: 1px solid var(--line); }
    .documents-conflict p { margin: 0 0 4px; } .documents-conflict .documents-actions { margin: 8px 0 0; }
    .documents-path { overflow-wrap: anywhere; min-width: 0; font-weight: 600; } .documents-path small { font-weight: 400; }
    #documents-deleted-dialog { max-height: calc(100vh - 32px); overflow-y: auto; }
    #documents-load-error button { padding: 2px 8px; font-size: 12px; }
    .documents-saved { color: var(--on); font-size: 12px; margin-left: 10px; font-weight: 400; }
    @media (max-width: 470px) { .documents-actions button, #documents-choose, #documents-deleted-dialog button { min-height: 44px; } }
  `
  document.head.append(style)
  tab.innerHTML = `
    <div class="section-heading"><h2 id="documents-heading"></h2><span id="documents-saved" class="documents-saved" role="status"></span></div>
    <div class="documents-heading">
      <label class="switch" id="documents-switch"><span id="documents-switch-label"></span>
        <input type="checkbox" id="documents-enabled" role="switch" aria-labelledby="documents-switch-label" aria-describedby="documents-intro">
        <span class="track" aria-hidden="true"></span></label>
    </div>
    <p id="documents-intro" class="hint"></p>
    <div id="documents-status" class="documents-status" role="status">
      <p class="documents-state"><span id="documents-dot" class="documents-dot" aria-hidden="true"></span><span id="documents-state-text"></span></p>
      <p id="documents-detail" class="hint" hidden></p>
    </div>
    <p id="documents-load-error" class="field-error" hidden><span id="documents-load-error-text"></span> <button id="documents-reload" type="button"></button></p>
    <div id="documents-body">
      <p id="documents-folder-label" class="label"></p>
      <div class="documents-folder-row"><p id="documents-folder" class="path"></p><button id="documents-choose" type="button" aria-describedby="documents-folder"></button></div>
      <p id="documents-refusal" class="field-error" role="alert" hidden></p>
      <div class="documents-actions">
        <button id="documents-open-nessie" type="button" class="primary" hidden></button>
        <button id="documents-pause" type="button"></button>
        <button id="documents-open-folder" type="button"></button>
        <button id="documents-deleted" type="button"></button>
      </div>
      <section id="documents-held" class="documents-block" aria-labelledby="documents-held-title" hidden>
        <h3 id="documents-held-title"></h3><p id="documents-held-text"></p><ul id="documents-held-sample" class="documents-paths"></ul>
        <div class="documents-actions"><button id="documents-held-restore" type="button"></button><button id="documents-held-confirm" type="button" class="danger"></button></div>
      </section>
      <section id="documents-conflicts" aria-labelledby="documents-conflicts-title" hidden><h3 id="documents-conflicts-title"></h3><div id="documents-conflict-list"></div></section>
    </div>`
  for (const [id, body] of [
    ['documents-existing-dialog', '<h2 id="documents-existing-title" tabindex="-1"></h2><p id="documents-existing-body"></p><p id="documents-existing-path" class="path"></p>'
      + '<p class="dialog-error" role="alert" hidden></p><div class="actions"><button type="button" id="documents-existing-cancel"></button><button type="button" id="documents-existing-accept" class="primary"></button></div>'],
    ['documents-deleted-dialog', '<h2 id="documents-deleted-title" tabindex="-1"></h2><p id="documents-deleted-hint" class="hint"></p><div id="documents-deleted-list" aria-live="polite"></div>'
      + '<p class="dialog-error" role="alert" hidden></p><div class="actions"><button type="button" id="documents-deleted-open"></button><button type="button" id="documents-deleted-close"></button></div>'],
  ]) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    dialog.setAttribute('aria-labelledby', id.replace('-dialog', '-title'))
    dialog.innerHTML = body
    document.body.append(dialog)
  }

  const button = (label, onclick, { key, className, describedBy } = {}) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    if (className) node.className = className
    if (key) node.dataset.key = key
    if (describedBy) node.setAttribute('aria-describedby', describedBy)
    node.onclick = onclick
    return node
  }
  /** Rebuilding a list keeps keyboard focus on the same row's control, or moves it somewhere deliberate. */
  const keepFocus = (container, rebuild, fallback) => {
    const key = container.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
    rebuild()
    if (key === undefined) return
    const again = [...container.querySelectorAll('[data-key]')].find((node) => node.dataset.key === key && !node.disabled)
    ;(again ?? fallback()).focus()
  }

  /** What a person can do with one conflict row, decided by its kind (see the reason table in the schema). */
  const conflictActions = (executorId, conflict) => {
    const resolve = (resolution) => () => resolveConflict(executorId, conflict, resolution)
    const show = { label: t('show'), run: () => act(`show:${conflict.clientConflictId}`,
      () => native.syncOpenPath(executorId, 'file', conflict.relPath)), action: 'show' }
    if (conflict.kind === 'conflicted_copy') {
      return [{ label: t('keepMine'), run: resolve('keep_mine'), action: 'keep_mine' },
        { label: t('keepNessie'), run: resolve('keep_nessie'), action: 'keep_nessie' }, show]
    }
    if (conflict.kind === 'quarantined' && conflict.copy) {
      return [{ label: t('keepNessie'), run: resolve('keep_nessie'), action: 'keep_nessie' },
        { label: t('keepBoth'), run: resolve('dismiss'), action: 'dismiss' }, show]
    }
    const ok = { label: t('ok'), run: resolve('dismiss'), action: 'dismiss' }
    return conflict.reason.startsWith('access_removed') ? [ok] : [show, ok]
  }

  const renderConflicts = (executorId, state) => keepFocus(byId('documents-conflict-list'), () => {
    const list = byId('documents-conflict-list')
    list.replaceChildren()
    for (const conflict of state.conflicts) {
      const row = document.createElement('div')
      row.className = 'documents-conflict'
      const path = document.createElement('p')
      path.className = 'documents-path'
      path.id = `documents-conflict-${conflict.clientConflictId}`
      path.textContent = conflict.relPath
      const reason = document.createElement('p')
      reason.className = 'hint'
      reason.textContent = words.maybe(`reasons.${conflict.reason}`) ?? conflict.reason
      const actions = document.createElement('div')
      actions.className = 'documents-actions'
      const held = busy.has(conflict.clientConflictId)
      for (const action of conflictActions(executorId, conflict)) {
        const node = button(action.label, () => action.run(), { key: `${conflict.clientConflictId}:${action.action}`, describedBy: path.id })
        node.disabled = held && action.action !== 'show'
        actions.append(node)
      }
      row.append(path, reason, actions)
      list.append(row)
    }
  }, () => byId('documents-open-folder'))

  const renderHeld = (state) => {
    const held = state.heldDeletes
    byId('documents-held').hidden = !held
    if (!held) return
    byId('documents-held-text').textContent = held.reason === 'mass_delete'
      ? words.count('held.mass_delete', held.count) : t(`held.${held.reason}`)
    const sample = byId('documents-held-sample')
    sample.replaceChildren(...held.sample.map((relPath) => {
      const item = document.createElement('li')
      item.textContent = relPath
      return item
    }))
    if (held.count > held.sample.length) {
      const more = document.createElement('li')
      more.className = 'hint'
      more.textContent = words.count('held.more', held.count - held.sample.length)
      sample.append(more)
    }
    for (const id of ['documents-held-restore', 'documents-held-confirm']) byId(id).disabled = busy.has('held')
  }

  const renderWords = (team) => {
    byId('documents-heading').textContent = t('heading', { team })
    byId('documents-switch-label').textContent = t('switchLabel', { team })
    byId('documents-intro').textContent = t('intro', { team })
    for (const [id, key] of [['documents-folder-label', 'folder'], ['documents-choose', 'choose'], ['documents-open-nessie', 'openNessie'],
      ['documents-open-folder', 'openFolder'], ['documents-deleted', 'deletedFiles'], ['documents-reload', 'retry'],
      ['documents-held-title', 'held.heading'], ['documents-held-confirm', 'held.confirm'], ['documents-held-restore', 'held.restore'],
      ['documents-conflicts-title', 'conflicts'], ['documents-existing-title', 'existing.title'], ['documents-existing-accept', 'existing.accept'],
      ['documents-existing-cancel', 'existing.cancel'], ['documents-deleted-title', 'deleted.title'], ['documents-deleted-hint', 'deleted.hint'],
      ['documents-deleted-open', 'deleted.open'], ['documents-deleted-close', 'deleted.close']]) byId(id).textContent = t(key)
    for (const id of ['tab-documents', 'documents-existing-dialog', 'documents-deleted-dialog']) byId(id).lang = document.documentElement.lang
  }

  const render = () => {
    const executorId = nc.team.current()
    const state = stateOf(executorId)
    const failure = failed?.executorId === executorId ? failed.message : null
    const pendingSwitch = switchPending?.executorId === executorId ? switchPending.enabled : null
    const refused = refusal?.executorId === executorId ? refusal.reason : null
    const team = executorId ? nc.team.label(executorId) : ''
    const signature = JSON.stringify([executorId, team, document.documentElement.lang, state, failure, pendingSwitch, refused, [...busy]])
    if (signature === painted) return
    painted = signature
    renderWords(team)
    const key = state ? statusKey(state) : null
    const toggle = byId('documents-enabled')
    toggle.checked = pendingSwitch ?? Boolean(state?.enabled)
    toggle.disabled = !state || pendingSwitch !== null || key === 'not_private'
    byId('documents-status').hidden = !state && Boolean(failure)
    byId('documents-state-text').textContent = !state ? t('checking')
      : key === 'syncing' ? (pending(state) ? words.count('syncing', pending(state)) : t('syncingNone')) : t(`state.${key}`)
    byId('documents-dot').dataset.tone = TONES[key] ?? 'idle'
    const detail = key ? words.maybe(`detail.${key}`) : undefined
    byId('documents-detail').hidden = !detail
    byId('documents-detail').textContent = detail ?? ''
    byId('documents-load-error').hidden = !failure
    byId('documents-load-error-text').textContent = failure ? `${t('statusFailed')} ${failure}` : ''
    byId('documents-body').hidden = !state || key === 'not_private'
    if (!state || key === 'not_private') return
    byId('documents-folder').textContent = state.root ?? t('suggested', { path: state.defaultRoot })
    byId('documents-choose').disabled = pendingSwitch !== null
    byId('documents-refusal').hidden = !refused
    byId('documents-refusal').textContent = refused ? words.maybe(`refusals.${refused}`) ?? t('refusals.other') : ''
    const waitsForNessie = ['waiting_for_confirmation', 'needs_reauthorization'].includes(key)
    byId('documents-open-nessie').hidden = !waitsForNessie
    // Nothing is copying until Nessie allows it, so there is nothing to pause yet.
    byId('documents-pause').hidden = !state.enabled || waitsForNessie
    byId('documents-pause').textContent = state.paused ? t('resume') : t('pause')
    byId('documents-pause').disabled = busy.has('pause')
    byId('documents-open-folder').hidden = !state.root
    byId('documents-open-folder').disabled = key === 'root_missing'
    byId('documents-deleted').hidden = !state.root
    renderHeld(state)
    byId('documents-conflicts').hidden = !state.conflicts.length
    renderConflicts(executorId, state)
  }

  const load = async () => {
    const executorId = nc.team.current()
    if (!executorId || !shown()) return
    const asked = ++request
    try {
      const state = await native.syncStatus(executorId)
      if (asked !== request) return
      view = { executorId, state }
      if (failed?.executorId === executorId) failed = null
    } catch (error) {
      if (asked !== request) return
      failed = { executorId, message: String(error?.message ?? error) }
    }
    render()
  }

  /** One action at a time per key; the page stays usable and the button says it is busy. */
  const act = (key, run, target) => nc.attempt(async () => {
    if (busy.has(key)) return
    busy.add(key)
    render()
    try { await run() } finally {
      busy.delete(key)
      render()
    }
  }, target ? { target } : undefined)

  const flashSaved = (text) => {
    const note = byId('documents-saved')
    note.textContent = text
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { note.textContent = '' }, 4000)
  }

  /** Applies a command's answer and says which one it was: applied, confirm or refused. */
  const applyResult = (executorId, result, saved, command, target) => {
    if (result.outcome === 'applied') {
      if (refusal?.executorId === executorId) refusal = null
      request += 1
      view = { executorId, state: result.state }
      if (saved) flashSaved(t(`saved.${saved}`, { team: nc.team.label(executorId) }))
      render()
      return 'applied'
    }
    if (result.outcome === 'confirm_existing_files') {
      openExisting(executorId, command, saved, result.fileCount)
      return 'confirm'
    }
    const sentence = words.maybe(`refusals.${result.reason}`) ?? t('refusals.other')
    if (FOLDER_REFUSALS.has(result.reason)) {
      refusal = { executorId, reason: result.reason }
      render()
    } else {
      void load()
      throw new Error(sentence)
    }
    return 'refused'
  }

  /** A change waits behind every save already queued; its command is built when its turn comes. */
  const queueCommand = (executorId, build, saved, target) => autosave.now(`${executorId}:documents`, async () => {
    const command = build()
    return applyResult(executorId, await native.syncConfigure(executorId, command), saved, command, target)
  })

  const openExisting = (executorId, command, saved, fileCount) => {
    existing = { executorId, command, saved }
    byId('documents-existing-body').textContent = words.count('existing.body', fileCount, { team: nc.team.label(executorId) })
    byId('documents-existing-path').textContent = command.root
    const dialog = byId('documents-existing-dialog')
    if (!dialog.open) dialog.showModal()
    byId('documents-existing-cancel').focus()
  }

  byId('documents-enabled').onchange = () => {
    const executorId = nc.team.current()
    if (!stateOf(executorId)) return
    const enabled = byId('documents-enabled').checked
    switchPending = { executorId, enabled }
    render()
    nc.attempt(async () => {
      try {
        await queueCommand(executorId, () => {
          const state = stateOf(executorId)
          return { command: 'configure', root: state.root ?? state.defaultRoot, enabled, acceptExistingFiles: false }
        }, enabled ? 'on' : 'off')
      } finally {
        if (switchPending?.executorId === executorId) switchPending = null
        render()
      }
    }, { target: byId('documents-switch') })
  }
  byId('documents-choose').onclick = () => nc.attempt(async () => {
    const executorId = nc.team.current()
    const root = await native.syncPickFolder()
    if (!root || executorId !== nc.team.current()) return
    if (refusal?.executorId === executorId) refusal = null
    await queueCommand(executorId, () => ({ command: 'configure', root,
      enabled: stateOf(executorId)?.enabled ?? false, acceptExistingFiles: false }), 'folder')
  }, { target: byId('documents-choose') })
  byId('documents-existing-accept').onclick = () => nc.attempt(async () => {
    const pendingExisting = existing
    if (!pendingExisting) return
    const accept = byId('documents-existing-accept')
    accept.disabled = true
    try {
      const outcome = await queueCommand(pendingExisting.executorId,
        () => ({ ...pendingExisting.command, acceptExistingFiles: true }), pendingExisting.saved)
      if (outcome !== 'confirm') byId('documents-existing-dialog').close()
    } finally { accept.disabled = false }
  })
  byId('documents-existing-cancel').onclick = () => byId('documents-existing-dialog').close()
  byId('documents-existing-dialog').addEventListener('close', () => { existing = null })
  byId('documents-pause').onclick = () => {
    const executorId = nc.team.current()
    const paused = !stateOf(executorId)?.paused
    return act('pause', () => queueCommand(executorId, () => ({ command: 'pause', paused }), paused ? 'paused' : 'resumed'), byId('documents-pause'))
  }
  byId('documents-open-folder').onclick = () => act('open-root', () => native.syncOpenPath(nc.team.current(), 'root'), byId('documents-open-folder'))
  // The handshake's address opens this computer's page in Nessie; before the first handshake there is none yet.
  byId('documents-open-nessie').onclick = () => act('open-nessie', () => {
    const executorId = nc.team.current()
    return stateOf(executorId)?.manageUrl ? native.syncOpenNessie(executorId) : nc.invoke('executor_open_nessie', { executorId })
  }, byId('documents-open-nessie'))
  const decideHeld = (decision) => {
    const executorId = nc.team.current()
    const batchId = stateOf(executorId)?.heldDeletes?.batchId
    if (!batchId) return
    return act('held', () => queueCommand(executorId, () => ({ command: 'held_deletes', batchId, decision }), null), byId('documents-held'))
  }
  byId('documents-held-confirm').onclick = () => decideHeld('confirm')
  byId('documents-held-restore').onclick = () => decideHeld('restore')
  const resolveConflict = (executorId, conflict, resolution) => act(conflict.clientConflictId, async () => {
    applyResult(executorId, await native.syncResolve(executorId, conflict.clientConflictId, resolution), null, null)
  }, byId('documents-conflicts'))

  // Deleted files: the local trash, newest first as the CLI lists it.
  const renderDeleted = (executorId, entries) => keepFocus(byId('documents-deleted-list'), () => {
    const list = byId('documents-deleted-list')
    list.replaceChildren()
    if (!entries.length) {
      const empty = document.createElement('p')
      empty.className = 'hint'
      empty.textContent = t('deleted.empty')
      list.append(empty)
    }
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'folder-row'
      const name = document.createElement('div')
      name.className = 'folder-name documents-path'
      name.textContent = entry.relPath
      const when = document.createElement('small')
      when.textContent = t('deleted.on', { date: words.date(entry.deletedAt) })
      name.append(when)
      const restore = button(t('deleted.restore'), () => restoreDeleted(executorId, entry, restore), { key: entry.entryId })
      restore.setAttribute('aria-label', `${t('deleted.restore')} · ${entry.relPath}`)
      row.append(name, restore)
      list.append(row)
    }
  }, () => byId('documents-deleted-close'))
  const loadDeleted = async (executorId) => {
    const answer = await native.syncTrashList(executorId)
    if (deletedFor === executorId) renderDeleted(executorId, answer.entries)
  }
  const restoreDeleted = (executorId, entry, node) => nc.attempt(async () => {
    node.disabled = true
    try {
      const result = await native.syncTrashRestore(executorId, entry.entryId)
      if (applyResult(executorId, result, null, null) === 'applied') flashSaved(t('restored', { path: entry.relPath }))
      await loadDeleted(executorId)
    } finally { node.disabled = false }
  })
  byId('documents-deleted').onclick = () => nc.attempt(async () => {
    const executorId = nc.team.current()
    deletedFor = executorId
    const loading = document.createElement('p')
    loading.className = 'hint'
    loading.textContent = t('checking')
    byId('documents-deleted-list').replaceChildren(loading)
    byId('documents-deleted-dialog').showModal()
    byId('documents-deleted-title').focus()
    await loadDeleted(executorId)
  })
  byId('documents-deleted-open').onclick = () => nc.attempt(() => native.syncOpenPath(deletedFor, 'trash'))
  byId('documents-deleted-close').onclick = () => byId('documents-deleted-dialog').close()
  byId('documents-deleted-dialog').addEventListener('close', () => { deletedFor = null })
  byId('documents-reload').onclick = () => nc.attempt(load)

  // The tab reads its state when it comes into view, when its team changes, and every five seconds while open.
  const refresh = () => { if (shown()) { render(); void load() } }
  nc.view.onChange(refresh)
  nc.team.onChange(refresh)
  document.addEventListener('DOMContentLoaded', refresh)
  setInterval(() => { if (shown()) void load() }, 5000)
})()
