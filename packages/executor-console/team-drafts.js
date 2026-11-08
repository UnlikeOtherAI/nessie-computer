/**
 * What a person has asked a team's access to become, as one complete
 * configuration — never a list of separate edits. Every edit changes the
 * team's draft; a save sends the whole draft, and Try again sends the draft as
 * it stands, so no save or retry can carry stale values, drop an earlier edit
 * or undo a newer one. A team has at most one draft.
 *
 * The runtime applies a save live (contract §4.1): the team keeps its
 * connection, so nothing here reconnects, and nothing posts a notification.
 * A failure is shown beside the control that asked for the change, naming the
 * rule still in force.
 */
window.teamDrafts = (() => {
  const nc = window.nc
  const autosave = window.autosave
  const described = new Map() // executorId → the latest describe this page has seen
  const drafts = new Map() // executorId → { revision, savedRevision, sections, input }
  const edits = new Map() // executorId → how many edits, finished or not, the person has made
  const problems = new Map() // `${executorId}:${group}` → { target, message, retry }
  const savedListeners = []
  const changedListeners = []
  const t = (key, vars) => nc.t(`access.save.${key}`, vars)

  const editsOf = (executorId) => edits.get(executorId) ?? 0
  const noteEdit = (executorId) => { edits.set(executorId, editsOf(executorId) + 1) }
  const announce = (listeners, ...args) => { for (const listener of listeners) listener(...args) }

  /** The team's describe: the shell's read for this selection, or a fresh one. */
  const describe = async (executorId, { fresh = false } = {}) => {
    if (described.has(executorId)) return described.get(executorId)
    const value = await nc.team.describe(executorId, { fresh })
    described.set(executorId, value)
    return value
  }
  /** The describe a save answered with: the shell's cache follows it, so the Overview summary needs no second read. */
  const remember = (value) => {
    described.set(value.executorId, value)
    nc.team.remember(value.executorId, value)
    announce(changedListeners, value.executorId)
  }
  const forget = (executorId) => { described.delete(executorId) }

  /** The configuration a draft starts from: exactly what the team reports, field by field. */
  const inputOf = (saved) => ({
    workspaceFolders: saved.reach.folders.map((folder) => ({ name: folder.name, path: folder.path })),
    commandPolicy: JSON.parse(JSON.stringify(saved.commandPolicy)),
    existingCodingSessionsEnabled: saved.existingCodingSessionsEnabled !== false,
    allowedOrigins: [...(saved.reach.allowedOrigins ?? [])],
    ...(saved.mcpPolicy ? { mcpPolicy: { mode: saved.mcpPolicy.mode, disabled: [...saved.mcpPolicy.disabled] } } : {}),
  })
  /** What the page shows: the draft while one waits, otherwise what is saved. */
  const shown = (executorId) => drafts.get(executorId)?.input
    ?? (described.has(executorId) ? inputOf(described.get(executorId)) : null)

  // A problem sits beside the control that asked for the change, with Try again.
  const renderProblem = (key) => {
    const problem = problems.get(key)
    const id = `save-problem-${key.replace(/[^a-z0-9]+/gi, '-')}`
    const existing = document.getElementById(id)
    if (!problem) { existing?.remove(); return }
    const node = existing ?? document.createElement('p')
    node.id = id
    node.className = 'field-error save-problem'
    node.setAttribute('role', 'alert')
    node.replaceChildren()
    const message = document.createElement('span')
    message.textContent = problem.message
    node.append(message)
    if (problem.retry) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = t('tryAgain')
      retry.onclick = () => problem.retry()
      node.append(' ', retry)
    }
    const target = typeof problem.target === 'string' ? nc.byId(problem.target) : problem.target
    if (!existing || existing.previousElementSibling !== target) {
      target.parentElement.insertBefore(node, target.nextSibling)
    }
  }
  const setProblem = (executorId, group, problem) => {
    const key = `${executorId}:${group}`
    if (problem) problems.set(key, problem)
    else problems.delete(key)
    renderProblem(key)
  }
  /** A disconnected team's problems and unsaved draft go with it: nothing is left to save them to. */
  const forgetTeam = (executorId) => {
    for (const key of [...problems.keys()]) if (key.startsWith(`${executorId}:`)) { problems.delete(key); renderProblem(key) }
    drafts.delete(executorId)
    described.delete(executorId)
  }

  /** The configuration a save sends: a copy of the draft, so later edits cannot change it mid-flight. */
  const copy = (input) => JSON.parse(JSON.stringify(input))
  const sameRules = (left = [], right = []) => {
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
    const now = inputOf(saved)
    const others = now.existingCodingSessionsEnabled === sent.existingCodingSessionsEnabled
      && now.commandPolicy.mode === sent.commandPolicy.mode
      && sameRules(now.commandPolicy.allowlist, sent.commandPolicy.allowlist)
      && sameRules(now.commandPolicy.denylist, sent.commandPolicy.denylist)
      && JSON.stringify(now.commandPolicy.trusted ?? null) === JSON.stringify(sent.commandPolicy.trusted ?? null)
      && sameRules(now.allowedOrigins, sent.allowedOrigins)
      && JSON.stringify(now.mcpPolicy ?? null) === JSON.stringify(sent.mcpPolicy ?? null)
    const pairs = (folders) => JSON.stringify(folders.map((folder) => `${folder.name}=${folder.path}`).sort())
    const names = (folders) => JSON.stringify(folders.map((folder) => folder.name).sort())
    if (!others || names(now.workspaceFolders) !== names(sent.workspaceFolders)) return 'different'
    return pairs(now.workspaceFolders) === pairs(sent.workspaceFolders) ? 'same' : 'unknown'
  }

  const retryDraft = (executorId) => () => {
    if (!drafts.has(executorId)) return
    setProblem(executorId, 'changes', null)
    nc.attempt(() => autosave.now(`${executorId}:changes`, saveTeam(executorId)))
  }

  /** Sends the team's draft as it is when the save runs. A later edit gets its own save. */
  const saveTeam = (executorId) => async () => {
    const draft = drafts.get(executorId)
    if (!draft || draft.revision === draft.savedRevision) return
    const revision = draft.revision
    const generation = editsOf(executorId)
    const sent = copy(draft.input)
    const { sections, target, inForce } = draft
    try {
      const base = await describe(executorId)
      const next = await nc.invoke('executor_configure', {
        executorId, configurationInput: { operationKeys: base.policy.operations, ...sent },
      })
      draft.savedRevision = revision
      if (drafts.get(executorId) === draft && draft.revision === revision) drafts.delete(executorId)
      remember(next)
      if (drafts.has(executorId)) return
      setProblem(executorId, 'changes', null)
      announce(savedListeners, executorId, [...sections])
    } catch (error) {
      await reportFailure({ executorId, draft, revision, generation, sent, sections, target, inForce,
        reason: error?.message ?? String(error) })
    }
  }

  /**
   * A save can fail before anything was written or after it, while reading the
   * result back. The team's settings are read again so the message says which,
   * and names the rule still in force. Only the outcome for the draft as it
   * still stands is reported; a newer edit has its own save.
   */
  const reportFailure = async ({
    executorId, draft, revision, generation, sent, sections, target, inForce, reason,
  }) => {
    const superseded = () => editsOf(executorId) !== generation
    const saved = await nc.invoke('executor_describe', { executorId }).catch(() => null)
    if (saved) remember(saved)
    const outcome = saved ? comparison(sent, saved) : 'unknown'
    const section = [...sections].map((name) => nc.t(`access.sections.${name}`)).join(` ${t('and')} `)
    if (outcome === 'same') {
      if (drafts.get(executorId) === draft && draft.revision === revision) drafts.delete(executorId)
      if (!superseded()) { setProblem(executorId, 'changes', null); announce(savedListeners, executorId, [...sections]) }
      return
    }
    if (superseded()) return
    const still = saved && inForce ? inForce(inputOf(saved)) : ''
    setProblem(executorId, 'changes', { target, retry: retryDraft(executorId), message: [outcome === 'different'
      ? t('notSaved', { section, reason }) : t('unconfirmed', { section, reason }), still].filter(Boolean).join(' ') })
  }

  /**
   * Changes a team's draft. `mutate` receives the draft input and answers false
   * when the edit changes nothing. `target` is the control the person used;
   * `inForce(input)` words the rule in force for a failure message.
   */
  const edit = (executorId, { section, target, inForce, mutate, immediately = true }) => {
    const saved = described.get(executorId)
    if (!saved) return false
    const draft = drafts.get(executorId)
      ?? { revision: 0, savedRevision: 0, sections: new Set(), input: inputOf(saved) }
    if (mutate(draft.input) === false) return false
    noteEdit(executorId)
    // Even an edit back to what is saved is sent: a save in flight may be about to change it.
    drafts.set(executorId, draft)
    draft.revision += 1
    draft.sections.add(section)
    draft.target = target
    draft.inForce = inForce
    setProblem(executorId, 'changes', null)
    announce(changedListeners, executorId)
    const run = saveTeam(executorId)
    if (immediately) autosave.now(`${executorId}:changes`, run)
    else autosave.schedule(`${executorId}:changes`, run)
    return true
  }

  return {
    describe, saved: (executorId) => described.get(executorId) ?? null, remember, forget, forgetTeam, shown, edit,
    hasDraft: (executorId) => drafts.has(executorId),
    /** A problem of this page's own, shown beside `target` the same way a save failure is. */
    problem: setProblem,
    /** Called with (executorId, sections) when a save has been confirmed. */
    onSaved: (listener) => { savedListeners.push(listener) },
    /** Called with (executorId) when the shown configuration changed: a draft edit or a fresh describe. */
    onChanged: (listener) => { changedListeners.push(listener) },
  }
})()
