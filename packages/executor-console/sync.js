// The Sync tab: one team's folder sync on this computer. Everything it shows
// comes from `nessie-executor sync status --json` (FolderSyncConsoleState);
// every change is a FolderSyncConsoleCommand the CLI checks and answers with a
// FolderSyncConsoleCommandResult. Settings save as they change, in the same
// queue as every other save, so a change never overtakes one still running.
const syncNative = window.executorNative
const syncText = window.syncConsoleWords
const syncWords = syncText.words
/** Refusals about the chosen folder are shown under it; the rest under the tabs. */
const SYNC_FOLDER_REFUSALS = new Set(['root_not_absolute', 'root_missing', 'root_not_a_directory', 'root_is_link',
  'root_not_writable', 'root_overlaps_workspace_folder', 'root_inside_state_directory', 'root_inside_other_sync',
  'not_private'])
const SYNC_TONES = { up_to_date: 'ok', syncing: 'busy', starting: 'busy', waiting_for_confirmation: 'wait',
  needs_reauthorization: 'warn', root_missing: 'warn', disk_full: 'warn', needs_attention: 'warn' }

let syncView = null // { executorId, state }
let syncFailed = null // { executorId, message }
let syncSwitchPending = null // { executorId, enabled }
let syncRefusal = null // { executorId, reason }
let syncExisting = null // { executorId, command, saved }
let syncDeletedFor = null
let syncRequest = 0
let syncPainted = ''
const syncBusy = new Set()

const syncStateOf = (executorId) => (syncView?.executorId === executorId ? syncView.state : null)
const syncPanelShown = () => currentTab === 'sync' && !byId('tab-sync').hidden
const syncPending = (state) => state.counts.pendingUploads + state.counts.pendingDownloads
const syncAsksForDecision = (state) => state.conflicts.length > 0 || state.heldDeletes !== null
  || state.counts.openConflicts + state.counts.heldDeletes + state.counts.errors > 0

/**
 * The status line is honest: it never says Up to date while anything is
 * pending, waiting or in conflict, whatever the engine last called its state.
 */
const syncStatusKey = (state) => {
  if (state.state === 'not_private') return 'not_private'
  if (!state.enabled) return 'off'
  if (state.paused) return 'paused'
  if (state.state !== 'up_to_date' && state.state !== 'syncing') return state.state
  const settled = syncPending(state) + state.counts.waiting === 0 && !syncAsksForDecision(state)
  if (state.state === 'up_to_date' && settled) return 'up_to_date'
  return syncAsksForDecision(state) && syncPending(state) === 0 ? 'needs_attention' : 'syncing'
}

const syncButton = (label, onclick, { key, className, describedBy } = {}) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  if (className) button.className = className
  if (key) button.dataset.key = key
  if (describedBy) button.setAttribute('aria-describedby', describedBy)
  button.onclick = onclick
  return button
}

/** What a person can do with one conflict row, decided by its kind (see the reason table in the schema). */
const syncConflictActions = (executorId, conflict) => {
  const resolve = (resolution) => () => resolveSyncConflict(executorId, conflict, resolution)
  const show = { label: syncWords.show, run: () => syncAct(`show:${conflict.clientConflictId}`,
    () => syncNative.syncOpenPath(executorId, 'file', conflict.relPath)), action: 'show' }
  if (conflict.kind === 'conflicted_copy') {
    return [{ label: syncWords.keepMine, run: resolve('keep_mine'), action: 'keep_mine' },
      { label: syncWords.keepNessie, run: resolve('keep_nessie'), action: 'keep_nessie' }, show]
  }
  if (conflict.kind === 'quarantined' && conflict.copy) {
    return [{ label: syncWords.keepNessie, run: resolve('keep_nessie'), action: 'keep_nessie' },
      { label: syncWords.keepBoth, run: resolve('dismiss'), action: 'dismiss' }, show]
  }
  const ok = { label: syncWords.ok, run: resolve('dismiss'), action: 'dismiss' }
  return conflict.reason.startsWith('access_removed') ? [ok] : [show, ok]
}

const renderSyncConflicts = (executorId, state) => keepFocus(byId('sync-conflict-list'), () => {
  const list = byId('sync-conflict-list')
  list.replaceChildren()
  for (const conflict of state.conflicts) {
    const row = document.createElement('div')
    row.className = 'sync-conflict'
    const path = document.createElement('p')
    path.className = 'sync-path'
    path.id = `sync-conflict-${conflict.clientConflictId}`
    path.textContent = conflict.relPath
    const reason = document.createElement('p')
    reason.className = 'hint'
    reason.textContent = syncWords.reasons[conflict.reason] ?? conflict.reason
    const actions = document.createElement('div')
    actions.className = 'sync-actions'
    const busy = syncBusy.has(conflict.clientConflictId)
    for (const action of syncConflictActions(executorId, conflict)) {
      const button = syncButton(action.label, () => action.run(),
        { key: `${conflict.clientConflictId}:${action.action}`, describedBy: path.id })
      button.disabled = busy && action.action !== 'show'
      actions.append(button)
    }
    row.append(path, reason, actions)
    list.append(row)
  }
}, () => byId('sync-open-folder'))

const renderSyncHeld = (state) => {
  const held = state.heldDeletes
  byId('sync-held').hidden = !held
  if (!held) return
  byId('sync-held-text').textContent = held.reason === 'mass_delete'
    ? syncText.count('held.mass_delete', held.count) : syncWords.held[held.reason]
  const sample = byId('sync-held-sample')
  sample.replaceChildren(...held.sample.map((relPath) => {
    const item = document.createElement('li')
    item.textContent = relPath
    return item
  }))
  if (held.count > held.sample.length) {
    const more = document.createElement('li')
    more.className = 'hint'
    more.textContent = syncText.count('held.more', held.count - held.sample.length)
    sample.append(more)
  }
  for (const id of ['sync-held-restore', 'sync-held-confirm']) byId(id).disabled = syncBusy.has('held')
}

const renderSync = () => {
  const executorId = currentExecutorId
  const state = syncStateOf(executorId)
  const failed = syncFailed?.executorId === executorId ? syncFailed.message : null
  const pendingSwitch = syncSwitchPending?.executorId === executorId ? syncSwitchPending.enabled : null
  const refusal = syncRefusal?.executorId === executorId ? syncRefusal.reason : null
  const signature = JSON.stringify([executorId, state, failed, pendingSwitch, refusal, [...syncBusy]])
  if (signature === syncPainted) return
  syncPainted = signature
  const key = state ? syncStatusKey(state) : null
  const toggle = byId('sync-enabled')
  toggle.checked = pendingSwitch ?? Boolean(state?.enabled)
  toggle.disabled = !state || pendingSwitch !== null || key === 'not_private'
  byId('sync-status').hidden = !state && Boolean(failed)
  byId('sync-state-text').textContent = !state ? syncWords.checking
    : key === 'syncing' ? (syncPending(state) ? syncText.count('syncing', syncPending(state)) : syncWords.syncingNone)
      : syncWords.state[key]
  byId('sync-dot').dataset.tone = SYNC_TONES[key] ?? 'idle'
  const detail = key ? syncWords.detail[key] : undefined
  byId('sync-detail').hidden = !detail
  byId('sync-detail').textContent = detail ?? ''
  byId('sync-load-error').hidden = !failed
  byId('sync-load-error-text').textContent = failed ? `${syncWords.statusFailed} ${failed}` : ''
  byId('sync-body').hidden = !state || key === 'not_private'
  if (!state || key === 'not_private') return
  byId('sync-folder').textContent = state.root ?? syncText.text('suggested', { path: state.defaultRoot })
  byId('sync-choose').disabled = pendingSwitch !== null
  byId('sync-refusal').hidden = !refusal
  byId('sync-refusal').textContent = refusal ? syncWords.refusals[refusal] ?? syncWords.refusals.other : ''
  const waitsForNessie = ['waiting_for_confirmation', 'needs_reauthorization'].includes(key)
  byId('sync-open-nessie').hidden = !waitsForNessie
  // Nothing is copying until Nessie allows it, so there is nothing to pause yet.
  byId('sync-pause').hidden = !state.enabled || waitsForNessie
  byId('sync-pause').textContent = state.paused ? syncWords.resume : syncWords.pause
  byId('sync-pause').disabled = syncBusy.has('pause')
  byId('sync-open-folder').hidden = !state.root
  byId('sync-open-folder').disabled = key === 'root_missing'
  byId('sync-deleted').hidden = !state.root
  renderSyncHeld(state)
  byId('sync-conflicts').hidden = !state.conflicts.length
  renderSyncConflicts(executorId, state)
}

const loadSync = async () => {
  const executorId = currentExecutorId
  if (!executorId || !syncPanelShown()) return
  const asked = ++syncRequest
  try {
    const state = await syncNative.syncStatus(executorId)
    if (asked !== syncRequest) return
    syncView = { executorId, state }
    if (syncFailed?.executorId === executorId) syncFailed = null
  } catch (error) {
    if (asked !== syncRequest) return
    syncFailed = { executorId, message: String(error?.message ?? error) }
  }
  renderSync()
}

/** One action at a time per key; the page stays usable and the button says it is busy. */
const syncAct = (key, run) => attempt(async () => {
  if (syncBusy.has(key)) return
  syncBusy.add(key)
  renderSync()
  try { await run() } finally {
    syncBusy.delete(key)
    renderSync()
  }
})

/** Applies a command's answer and says which one it was: applied, confirm or refused. */
const applySyncResult = (executorId, result, saved, command) => {
  if (result.outcome === 'applied') {
    if (syncRefusal?.executorId === executorId) syncRefusal = null
    syncRequest += 1
    syncView = { executorId, state: result.state }
    if (saved) savedSinceIdle = syncText.text(`saved.${saved}`, { team: teamLabel(executorId) })
    renderSync()
    return 'applied'
  }
  if (result.outcome === 'confirm_existing_files') {
    openSyncExisting(executorId, command, saved, result.fileCount)
    return 'confirm'
  }
  const sentence = syncWords.refusals[result.reason] ?? syncWords.refusals.other
  if (SYNC_FOLDER_REFUSALS.has(result.reason)) {
    syncRefusal = { executorId, reason: result.reason }
    renderSync()
  } else {
    reportError(sentence)
    void loadSync()
  }
  return 'refused'
}

/**
 * A change waits behind every save already queued, and its command is built
 * when its turn comes, so it carries the folder and switch as they are then.
 */
const queueSyncCommand = (executorId, build, saved) => autosave.now(`${executorId}:sync`, async () => {
  const command = build()
  return applySyncResult(executorId, await syncNative.syncConfigure(executorId, command), saved, command)
})

const openSyncExisting = (executorId, command, saved, fileCount) => {
  syncExisting = { executorId, command, saved }
  byId('sync-existing-body').textContent = syncText.count('existing.body', fileCount, { team: teamLabel(executorId) })
  byId('sync-existing-path').textContent = command.root
  const dialog = byId('sync-existing-dialog')
  if (!dialog.open) dialog.showModal()
  byId('sync-existing-cancel').focus()
}

byId('sync-enabled').onchange = () => {
  const executorId = currentExecutorId
  if (!syncStateOf(executorId)) return
  const enabled = byId('sync-enabled').checked
  syncSwitchPending = { executorId, enabled }
  renderSync()
  setSaveNote('Saving…')
  attempt(async () => {
    try {
      await queueSyncCommand(executorId, () => {
        const state = syncStateOf(executorId)
        return { command: 'configure', root: state.root ?? state.defaultRoot, enabled, acceptExistingFiles: false }
      }, enabled ? 'on' : 'off')
    } finally {
      if (syncSwitchPending?.executorId === executorId) syncSwitchPending = null
      renderSync()
    }
  })
}

byId('sync-choose').onclick = () => attempt(async () => {
  const executorId = currentExecutorId
  const root = await syncNative.syncPickFolder()
  if (!root || executorId !== currentExecutorId) return
  if (syncRefusal?.executorId === executorId) syncRefusal = null
  setSaveNote('Saving…')
  await queueSyncCommand(executorId, () => ({ command: 'configure', root,
    enabled: syncStateOf(executorId)?.enabled ?? false, acceptExistingFiles: false }), 'folder')
})

byId('sync-existing-accept').onclick = () => attempt(async () => {
  const pending = syncExisting
  if (!pending) return
  const accept = byId('sync-existing-accept')
  accept.disabled = true
  try {
    const outcome = await queueSyncCommand(pending.executorId,
      () => ({ ...pending.command, acceptExistingFiles: true }), pending.saved)
    if (outcome !== 'confirm') byId('sync-existing-dialog').close()
  } finally { accept.disabled = false }
})
byId('sync-existing-dialog').addEventListener('close', () => { syncExisting = null })

byId('sync-pause').onclick = () => {
  const executorId = currentExecutorId
  const paused = !syncStateOf(executorId)?.paused
  return syncAct('pause', () => queueSyncCommand(executorId, () => ({ command: 'pause', paused }),
    paused ? 'paused' : 'resumed'))
}
byId('sync-open-folder').onclick = () => syncAct('open-root', () => syncNative.syncOpenPath(currentExecutorId, 'root'))
// The handshake's address opens this computer's Sync tab; before the first
// handshake there is none yet, and Nessie opens where the footer button opens it.
byId('sync-open-nessie').onclick = () => syncAct('open-nessie', () => {
  const executorId = currentExecutorId
  return syncStateOf(executorId)?.manageUrl ? syncNative.syncOpenNessie(executorId)
    : invoke('executor_open_nessie', { apiBaseUrl: connectionNames.get(executorId)?.apiBaseUrl ?? 'nessie' })
})

const decideHeld = (decision) => {
  const executorId = currentExecutorId
  const batchId = syncStateOf(executorId)?.heldDeletes?.batchId
  if (!batchId) return
  return syncAct('held', () => queueSyncCommand(executorId, () => ({ command: 'held_deletes', batchId, decision }), null))
}
byId('sync-held-confirm').onclick = () => decideHeld('confirm')
byId('sync-held-restore').onclick = () => decideHeld('restore')

const resolveSyncConflict = (executorId, conflict, resolution) => syncAct(conflict.clientConflictId, async () => {
  const result = await syncNative.syncResolve(executorId, conflict.clientConflictId, resolution)
  applySyncResult(executorId, result, null, null)
})

// Deleted files: the local trash, newest first as the CLI lists it.
const renderSyncDeleted = (executorId, entries) => keepFocus(byId('sync-deleted-list'), () => {
  const list = byId('sync-deleted-list')
  list.replaceChildren()
  if (!entries.length) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.textContent = syncWords.deleted.empty
    list.append(empty)
  }
  for (const entry of entries) {
    const row = document.createElement('div')
    row.className = 'folder-row'
    const name = document.createElement('div')
    name.className = 'folder-name sync-path'
    name.textContent = entry.relPath
    const when = document.createElement('small')
    when.textContent = syncText.text('deleted.on', { date: syncText.date(entry.deletedAt) })
    name.append(when)
    const restore = syncButton(syncWords.deleted.restore, () => restoreSyncDeleted(executorId, entry, restore),
      { key: entry.entryId })
    restore.setAttribute('aria-label', `${syncWords.deleted.restore} · ${entry.relPath}`)
    row.append(name, restore)
    list.append(row)
  }
}, () => byId('sync-deleted-close'))

const loadSyncDeleted = async (executorId) => {
  const answer = await syncNative.syncTrashList(executorId)
  if (syncDeletedFor === executorId) renderSyncDeleted(executorId, answer.entries)
}
const restoreSyncDeleted = (executorId, entry, button) => attempt(async () => {
  button.disabled = true
  try {
    const result = await syncNative.syncTrashRestore(executorId, entry.entryId)
    if (applySyncResult(executorId, result, null, null) === 'applied') {
      setSaveNote(syncText.text('restored', { path: entry.relPath }))
    }
    await loadSyncDeleted(executorId)
  } finally { button.disabled = false }
})
byId('sync-deleted').onclick = () => attempt(async () => {
  const executorId = currentExecutorId
  syncDeletedFor = executorId
  const loading = document.createElement('p')
  loading.className = 'hint'
  loading.textContent = syncWords.checking
  byId('sync-deleted-list').replaceChildren(loading)
  byId('sync-deleted-dialog').showModal()
  byId('sync-deleted-title').focus()
  await loadSyncDeleted(executorId)
})
byId('sync-deleted-open').onclick = () => attempt(() => syncNative.syncOpenPath(syncDeletedFor, 'trash'))
byId('sync-deleted-dialog').addEventListener('close', () => { syncDeletedFor = null })
byId('sync-reload').onclick = () => attempt(loadSync)

// The words that do not change with the state.
for (const [id, text] of [['sync-switch-label', syncWords.switchLabel], ['sync-intro', syncWords.intro],
  ['sync-folder-label', syncWords.folder], ['sync-choose', syncWords.choose], ['sync-open-nessie', syncWords.openNessie],
  ['sync-open-folder', syncWords.openFolder], ['sync-deleted', syncWords.deletedFiles], ['sync-reload', syncWords.retry],
  ['sync-held-title', syncWords.held.heading], ['sync-held-confirm', syncWords.held.confirm],
  ['sync-held-restore', syncWords.held.restore], ['sync-conflicts-title', syncWords.conflicts],
  ['sync-existing-title', syncWords.existing.title], ['sync-existing-accept', syncWords.existing.accept],
  ['sync-existing-cancel', syncWords.existing.cancel], ['sync-deleted-title', syncWords.deleted.title],
  ['sync-deleted-hint', syncWords.deleted.hint], ['sync-deleted-open', syncWords.deleted.open],
  ['sync-deleted-close', syncWords.deleted.close]]) byId(id).textContent = text
byId('tab-sync').lang = syncText.locale
for (const id of ['sync-existing-dialog', 'sync-deleted-dialog']) byId(id).lang = syncText.locale

// The tab reads its state when it comes into view, when its tab is pressed
// again, and every five seconds while it is open.
new MutationObserver(() => {
  if (!syncPanelShown()) return
  renderSync()
  void loadSync()
}).observe(byId('tab-sync'), { attributes: true, attributeFilter: ['hidden'] })
byId('tab-button-sync').addEventListener('click', () => { if (syncPanelShown()) void loadSync() }, true)
setInterval(() => { if (syncPanelShown()) void loadSync() }, 5000)
