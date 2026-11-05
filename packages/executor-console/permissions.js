const lines = (id) => byId(id).value.split('\n').map((line) => line.trim()).filter(Boolean)
// A folder is shown by its own name, as the person's file manager shows it.
const folderLabel = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

const renderChannel = (value) => {
  const configuration = value.existingClaudeChannelConfiguration
  byId('claude-steps').hidden = !configuration
  byId('claude-unavailable').hidden = Boolean(configuration)
  byId('claude-channel-config').textContent = configuration ? JSON.stringify(configuration, null, 2) : ''
}

const renderFolders = (value) => keepFocus(byId('reach-folders'), () => {
  const folders = byId('reach-folders')
  folders.replaceChildren()
  const shown = shownFolders(value)
  for (const folder of shown) {
    const row = document.createElement('div')
    row.className = 'folder-row'
    const name = document.createElement('div')
    name.className = 'folder-name'
    name.textContent = folderLabel(folder.path)
    const path = document.createElement('small')
    path.textContent = folder.path
    name.append(path)
    const remove = document.createElement('button')
    remove.textContent = 'Remove'
    remove.disabled = shown.length === 1
    remove.dataset.key = folder.name
    remove.setAttribute('aria-label', `Stop sharing ${folderLabel(folder.path)} with ${teamLabel(value.executorId)}`)
    remove.onclick = () => editTeam('Folders', (draft) => {
      if (!draft.workspaceFolders.some((entry) => entry.name === folder.name)) return false
      draft.workspaceFolders = draft.workspaceFolders.filter((entry) => entry.name !== folder.name)
      queueMicrotask(() => renderFolders(description))
      return true
    }, true)
    row.append(name, remove)
    folders.append(row)
  }
  byId('last-folder').hidden = shown.length !== 1
}, () => byId('add-folder'))

const renderAllowlistState = () => {
  const listed = byId('command-mode').value === 'allowlist'
  byId('command-allowlist').disabled = !listed
  byId('allowlist-unused').hidden = listed
  byId('allowlist-needed').hidden = !listed || lines('command-allowlist').length > 0
}

const renderCommandFields = (policy) => {
  byId('command-mode').value = policy.mode
  byId('command-allowlist').value = policy.allowlist.join('\n')
  byId('command-denylist').value = policy.denylist.join('\n')
  renderAllowlistState()
}

/**
 * `fields` repaints the editable inputs. It is set only when a team's
 * settings are first shown: repainting after a save would overwrite whatever
 * the person typed while that save was running.
 */
const renderPermissions = (value, { fields }) => {
  renderChannel(value)
  renderFolders(value)
  if (!fields) return
  byId('existing-coding-sessions').checked = value.existingCodingSessionsEnabled !== false
  renderCommandFields(value.commandPolicy)
}

/** Coming back to a team shows what was asked of it and not yet saved. */
const restoreDrafts = (executorId) => {
  const draft = drafts.get(executorId)
  if (draft) {
    byId('existing-coding-sessions').checked = draft.existingCodingSessionsEnabled
    renderCommandFields(draft.commandPolicy)
  }
  const incomplete = saveProblems.get(incompleteGroup(executorId))?.commandPolicy
  if (incomplete) renderCommandFields(incomplete)
}

/**
 * The command rules as they stand now. Only listed commands with an empty
 * list would refuse everything, so that choice waits, visibly, until the list
 * has its first command; the rules already saved stay in force meanwhile.
 */
const editCommands = (immediately) => {
  renderAllowlistState()
  if (!currentExecutorId) return
  const commandPolicy = {
    mode: byId('command-mode').value, allowlist: lines('command-allowlist'), denylist: lines('command-denylist'),
  }
  const incomplete = commandPolicy.mode === 'allowlist' && !commandPolicy.allowlist.length
  // An unfinished list is an edit too: a save sent before it no longer speaks for the page.
  if (incomplete) noteEdit(currentExecutorId)
  setSaveProblem(incompleteGroup(currentExecutorId), incomplete
    ? { commandPolicy, message: 'Command changes not saved. Add at least one allowed command.' } : null)
  // An unfinished list is never sent: the draft goes back to the rules in force,
  // so a save already waiting cannot send a half-typed list.
  const commands = incomplete ? { ...description.commandPolicy } : commandPolicy
  editTeam('Commands', (draft) => {
    if (!incomplete) { draft.commandPolicy = commands; return true }
    if (!drafts.has(currentExecutorId)) return false
    draft.commandPolicy = commands
    return true
  }, immediately || incomplete)
}

// A new folder is named after its directory, the way the runtime names one.
const folderName = (path, folders) => {
  const stem = folderLabel(path).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'folder'
  const taken = new Set(folders.map((folder) => folder.name))
  let name = stem
  for (let index = 2; taken.has(name); index += 1) name = `${stem.slice(0, 36)}-${index}`
  return name
}

byId('add-folder').onclick = () => attempt(async () => {
  const path = await invoke('executor_choose_folder')
  // Native and runtime validation own path, overlap and name rules.
  if (path) editTeam('Folders', (draft) => {
    if (draft.workspaceFolders.some((folder) => folder.path === path)) return false
    draft.workspaceFolders = [...draft.workspaceFolders, { name: folderName(path, draft.workspaceFolders), path }]
    queueMicrotask(() => renderFolders(description))
    return true
  }, true)
})
byId('command-mode').onchange = () => editCommands(true)
for (const id of ['command-allowlist', 'command-denylist']) {
  byId(id).oninput = () => editCommands(false)
  byId(id).onblur = () => autosave.flush()
}
byId('existing-coding-sessions').onchange = () => {
  const enabled = byId('existing-coding-sessions').checked
  editTeam('Existing sessions', (draft) => { draft.existingCodingSessionsEnabled = enabled }, true)
}

byId('open-claude-channel').onclick = () => { clearErrors(); byId('claude-dialog').showModal() }
for (const button of document.querySelectorAll('[data-copy]')) {
  button.onclick = () => attempt(async () => {
    const block = byId(button.dataset.copy)
    try {
      await navigator.clipboard.writeText(block.textContent)
      button.textContent = 'Copied'
      setTimeout(() => { button.textContent = 'Copy' }, 2000)
    } catch {
      // The page may not be allowed to write to the clipboard; the text is selected instead.
      window.getSelection().selectAllChildren(block)
      throw new Error('Couldn’t copy. The text is selected: press ⌘C or Ctrl+C.')
    }
  })
}

// An app-wide switch the host keeps: read it with `executor_<name>`, change it
// with `executor_set_<name>`, and show what the host reports afterwards.
const appSetting = (id, name, savedText) => {
  const load = async () => { byId(id).checked = (await invoke(`executor_${name}`)).enabled }
  byId(id).onchange = () => {
    const enabled = byId(id).checked
    setSaveNote('Saving…')
    attempt(() => autosave.now(id, async () => {
      try {
        await invoke(`executor_set_${name}`, { enabled })
        savedSinceIdle = savedText(enabled)
      } finally { await load() }
    }))
  }
  return load
}
const loadAutostart = appSetting('autostart', 'autostart', (enabled) => (
  enabled ? 'Nessie Executor opens when you log in' : 'Nessie Executor no longer opens when you log in'
))
const loadAutoRestart = appSetting('auto-restart', 'auto_restart', (enabled) => (
  enabled ? 'Stopped connections restart on their own' : 'Stopped connections stay stopped until you start them'
))
