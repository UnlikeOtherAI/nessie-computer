/**
 * What a person has asked a team's settings to become, as one complete
 * configuration — never a list of separate edits. Every edit changes the
 * team's draft; a save sends the whole draft, and Try again sends the draft as
 * it is now, so no save or retry can carry stale values, drop an earlier edit
 * or undo a newer one. A team has at most one draft and one problem.
 */
const drafts = new Map()
const changesGroup = (executorId) => `${executorId}:changes`
const incompleteGroup = (executorId) => `${executorId}:incomplete`
// A saved change whose team did not come back. Kept apart from the draft's
// problem, so a later edit cannot hide it; it clears once the team is seen
// connected, or when the person turns connections off.
const connectionGroup = (executorId) => `${executorId}:connection`
// Only a status observation requested after the note appeared may clear it;
// an older answer still in flight describes the team before it dropped.
const clearRecoveredConnections = (asked) => {
  for (const connection of connections) {
    const problem = saveProblems.get(connectionGroup(connection.executorId))
    if (problem && isRunning(connection) && asked > problem.since) setSaveProblem(connectionGroup(connection.executorId), null)
  }
}

// Every edit to a team counts — an unfinished one too — so a save's late
// outcome can tell whether the person has changed anything since it was sent.
const teamEdits = new Map()
const editsOf = (executorId) => teamEdits.get(executorId) ?? 0
const noteEdit = (executorId) => { teamEdits.set(executorId, editsOf(executorId) + 1) }
const connectionRunning = (executorId) => ['running', 'starting'].includes(
  connections.find((connection) => connection.executorId === executorId)?.daemonStatus,
)

/** The folders the page shows: the draft's while one is waiting, otherwise what is saved. */
const shownFolders = (value) => drafts.get(value.executorId)?.workspaceFolders ?? value.reach.folders

/**
 * Changes the current team's draft. `mutate` answers false when the edit
 * changes nothing, and then nothing is saved.
 */
const editTeam = (section, mutate, immediately) => {
  const executorId = currentExecutorId
  if (!executorId || description?.executorId !== executorId) return
  const draft = drafts.get(executorId) ?? {
    revision: 0, savedRevision: 0, sections: new Set(),
    workspaceFolders: description.reach.folders.map((folder) => ({ name: folder.name, path: folder.path })),
    commandPolicy: { ...description.commandPolicy },
    existingCodingSessionsEnabled: description.existingCodingSessionsEnabled !== false,
  }
  if (mutate(draft) === false) return
  noteEdit(executorId)
  // Even an edit back to what is saved is sent: a save in flight may be about to change it.
  drafts.set(executorId, draft)
  draft.revision += 1
  draft.sections.add(section)
  setSaveProblem(changesGroup(executorId), null)
  setSaveNote('Saving…')
  const run = saveTeam(executorId)
  if (immediately) autosave.now(changesGroup(executorId), run)
  else autosave.schedule(changesGroup(executorId), run)
}

/** The configuration a save sends: a copy of the draft, so later edits cannot change it mid-flight. */
const sentFrom = (draft) => ({
  workspaceFolders: draft.workspaceFolders.map((folder) => ({ name: folder.name, path: folder.path })),
  commandPolicy: { ...draft.commandPolicy },
  existingCodingSessionsEnabled: draft.existingCodingSessionsEnabled,
})

const sameRules = (left, right) => {
  const normal = (rules) => JSON.stringify(rules.map((rule) => rule.replace(/\s+/g, ' ').trim()).sort())
  return normal(left) === normal(right)
}
/**
 * Whether what the team now reports is what was sent: 'same', 'different', or
 * 'unknown' when only folder paths differ — the runtime stores a folder by
 * its resolved path, so a picked path can differ without being a different
 * folder, and the page cannot tell which.
 */
const comparison = (sent, saved) => {
  const others = (saved.existingCodingSessionsEnabled !== false) === sent.existingCodingSessionsEnabled
    && saved.commandPolicy.mode === sent.commandPolicy.mode
    && sameRules(saved.commandPolicy.allowlist, sent.commandPolicy.allowlist)
    && sameRules(saved.commandPolicy.denylist, sent.commandPolicy.denylist)
  const pairs = (folders) => JSON.stringify(folders.map((folder) => `${folder.name}=${folder.path}`).sort())
  const names = (folders) => JSON.stringify(folders.map((folder) => folder.name).sort())
  if (!others || names(saved.reach.folders) !== names(sent.workspaceFolders)) return 'different'
  return pairs(saved.reach.folders) === pairs(sent.workspaceFolders) ? 'same' : 'unknown'
}

const retryDraft = (executorId) => () => {
  if (!drafts.has(executorId)) return
  setSaveProblem(changesGroup(executorId), null)
  setSaveNote('Saving…')
  attempt(() => autosave.now(changesGroup(executorId), saveTeam(executorId)))
}

/** Sends the team's draft as it is when the save runs. A later edit gets its own save. */
const saveTeam = (executorId) => async () => {
  const draft = drafts.get(executorId)
  if (!draft || draft.revision === draft.savedRevision) return
  const revision = draft.revision
  const generation = editsOf(executorId)
  const sent = sentFrom(draft)
  const sections = [...draft.sections].join(' and ')
  const label = teamLabel(executorId)
  const wasRunning = connectionRunning(executorId)
  setSaveNote(`Saving and reconnecting ${label}…`)
  try {
    const base = description?.executorId === executorId ? description : await invoke('executor_describe', { executorId })
    const next = await invoke('executor_configure', {
      executorId, configurationInput: { operationKeys: base.policy.operations, ...sent },
    })
    draft.savedRevision = revision
    if (drafts.get(executorId) === draft && draft.revision === revision) drafts.delete(executorId)
    if (executorId === currentExecutorId) {
      description = next
      renderPermissions(next, { fields: false })
      if (!drafts.has(executorId)) byId('existing-coding-sessions').checked = next.existingCodingSessionsEnabled !== false
    }
    if (drafts.has(executorId)) return
    setSaveProblem(changesGroup(executorId), null)
    savedSinceIdle = `${sections} for ${label}`
  } catch (error) {
    // Reconciled even when newer edits exist: the connection may need reconnecting either way.
    await reportSaveFailure({
      executorId, draft, revision, generation, sent, sections, wasRunning, reason: error?.message ?? String(error),
    })
  }
}

/**
 * A save can fail before anything was written or after it — while reading
 * the result back or reconnecting. The team's settings and connection are
 * read again so the footer says which. Only the outcome for the draft as it
 * still stands is reported; a newer edit has its own save.
 */
const reportSaveFailure = async ({ executorId, draft, revision, generation, sent, sections, wasRunning, reason }) => {
  const label = teamLabel(executorId)
  const group = changesGroup(executorId)
  // Anything edited since this save was sent has its own save, which reports for
  // itself; the connection is checked here regardless, since that save would
  // find a stopped team and leave it stopped.
  const superseded = () => editsOf(executorId) !== generation
  const saved = await invoke('executor_describe', { executorId }).catch(() => null)
  const outcome = saved ? comparison(sent, saved) : 'unknown'
  if (saved && executorId === currentExecutorId) { description = saved; renderPermissions(saved, { fields: false }) }
  if (outcome !== 'same') {
    if (!superseded()) {
      setSaveProblem(group, { retry: retryDraft(executorId), message: outcome === 'different'
        ? `${sections} for ${label} weren’t saved: ${reason} Your previous settings still apply.`
        : `Couldn’t confirm whether ${sections.toLowerCase()} for ${label} were saved. ${reason}` })
    }
  } else {
    if (drafts.get(executorId) === draft && draft.revision === revision) drafts.delete(executorId)
    if (!superseded()) setSaveProblem(group, null)
    if (executorId === currentExecutorId && !drafts.has(executorId)) {
      byId('existing-coding-sessions').checked = saved.existingCodingSessionsEnabled !== false
    }
  }
  const asked = beginStatusRequest()
  let view = await invoke('executor_view').catch(() => null)
  if (view?.kind !== 'reachable') view = null
  if (view) applyView(view, asked)
  if (view && (!wasRunning || connectionRunning(executorId))) {
    if (outcome === 'same' && !superseded()) savedSinceIdle = `${sections} for ${label}`
    return
  }
  // A team that was connected and is not now needs reconnecting, whatever else happened.
  setSaveProblem(connectionGroup(executorId), { since: statusRequests, retry: reconnect(executorId), message: view
    ? `${label} isn’t connected after saving: ${reason}`
    : `${label}’s connection couldn’t be checked after saving. ${reason}` })
}

/**
 * Turns this one team on again and waits, up to ten seconds, for it to
 * connect. It shares the switch's place in the queue, so a later Off still wins.
 */
const reconnect = (executorId) => () => attempt(() => autosave.now('switch', async () => {
  const label = teamLabel(executorId)
  const group = connectionGroup(executorId)
  setSaveNote(`Reconnecting ${label}…`)
  let asked = beginStatusRequest()
  applyView(await invoke('executor_reconnect', { executorId }), asked)
  for (let waited = 0; !connectionRunning(executorId) && waited < 10_000; waited += 500) {
    await new Promise((resume) => setTimeout(resume, 500))
    asked = beginStatusRequest()
    applyView(await invoke('executor_view'), asked)
  }
  if (connectionRunning(executorId)) {
    setSaveProblem(group, null)
    setSaveNote(`${label} is connected again.`)
  } else {
    setSaveNote('')
    setSaveProblem(group, { since: statusRequests, retry: reconnect(executorId), message: `${label} still isn’t connected. Try again, or check the team on Teams.` })
  }
}))
