// Programs: the one Access section that applies explicitly. "Now" is always
// what the team reports; edits gather in a draft shown beside it as an
// "After Apply" line until Apply sends them in one save.
// No programs — only listed, with nothing listed and no built-in on — is a
// real, applicable state (contract §4.3).
(() => {
  const nc = window.nc
  const access = window.accessTab
  const t = access.t
  // The built-ins come from `describe.programDefaults` (contract §4.3); their switches are `commandPolicy.trusted`.
  const BUILTINS = ['unlikeotherai', 'claudeCode', 'codex', 't3Code']
  const defaults = (saved) => (saved.programDefaults ?? []).filter((entry) => BUILTINS.includes(entry.id))
  const SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'])
  const drafts = new Map() // executorId → the command policy as edited, not yet applied
  let nodes = null

  const copy = (policy) => JSON.parse(JSON.stringify(policy))
  const lines = (textarea) => textarea.value.split('\n').map((line) => line.trim()).filter(Boolean)
  /** The protocol's pattern grammar, read the same way: a plain program, literal arguments, an optional final `*`. */
  const validRule = (rule) => {
    if (!rule || rule.length > 512) return false
    const [program, ...rest] = rule.split(/\s+/u)
    if (!program || program.includes('/') || program.includes('\\') || SHELLS.has(program) || program.includes('*')) return false
    return !rest.slice(0, -1).some((token) => token.includes('*'))
  }
  const validName = (name) => /^[^\s/\\*"'`]{1,256}$/u.test(name) && !SHELLS.has(name)
  const programOf = (rule) => {
    const match = /^(\S+) \*$/u.exec(rule)
    return match ? match[1] : null
  }
  const same = (left, right) => JSON.stringify(normal(left)) === JSON.stringify(normal(right))
  const normal = (policy) => ({
    mode: policy.mode, allowlist: [...policy.allowlist].sort(), denylist: [...policy.denylist].sort(),
    trusted: policy.trusted ? BUILTINS.map((key) => Boolean(policy.trusted[key])) : null })
  const valid = (policy) => [...policy.allowlist, ...policy.denylist].every(validRule)

  /** One sentence for a policy: the built-ins and programs it allows, any program, or no programs. */
  const ruleWords = (policy) => {
    if (policy.mode === 'all') {
      const blocked = policy.denylist.map((rule) => programOf(rule) ?? rule)
      return blocked.length ? t('programs.anyExcept', { list: blocked.join(', ') }) : t('programs.anyProgram')
    }
    const names = [...BUILTINS.filter((key) => policy.trusted?.[key]).map((key) => t(`programs.builtins.${key}`)),
      ...policy.allowlist.map((rule) => programOf(rule) ?? rule)]
    return names.length ? names.join(', ') : t('programs.noPrograms')
  }

  const draftOf = (view) => drafts.get(view.executorId) ?? copy(view.saved.commandPolicy)
  const change = (mutate) => {
    const view = access.view()
    if (!view) return
    const draft = draftOf(view)
    mutate(draft)
    drafts.set(view.executorId, draft)
    access.render()
  }
  const setTrusted = (key, on) => change((draft) => {
    draft.trusted = Object.fromEntries(BUILTINS.map((name) => [name,
      name === key ? on : Boolean(draft.trusted?.[name])]))
  })

  const build = (node) => {
    node.innerHTML = `
      <div class="section-heading"><h3 id="access-programs-title"></h3><button type="button" id="access-add-program"></button></div>
      <div class="access-mode" role="radiogroup" aria-labelledby="access-mode-label">
        <span id="access-mode-label" class="label"></span>
        <label class="toggle"><input type="radio" name="access-mode" id="access-mode-allowlist" value="allowlist"><span id="access-mode-allowlist-text"></span></label>
        <label class="toggle"><input type="radio" name="access-mode" id="access-mode-all" value="all"><span id="access-mode-all-text"></span></label>
        <p id="access-mode-consequence" class="hint"></p>
      </div>
      <div id="access-program-list"></div>
      <details id="access-advanced"><summary id="access-advanced-summary"></summary>
        <div class="label-row"><label for="access-allowlist" id="access-allowlist-label"></label></div>
        <textarea id="access-allowlist" rows="3" spellcheck="false"></textarea>
        <label for="access-denylist" id="access-denylist-label"></label>
        <textarea id="access-denylist" rows="3" spellcheck="false"></textarea>
        <p id="access-pattern-error" class="field-error" role="alert" hidden></p>
      </details>
      <div class="access-apply">
        <div class="access-lines"><p id="access-now"></p><p id="access-after"></p><p id="access-no-programs-note" class="hint" hidden></p></div>
        <button type="button" id="access-undo"></button>
        <button type="button" id="access-apply" class="primary"></button>
      </div>`
    nodes = Object.fromEntries(['add-program', 'mode-label', 'mode-allowlist', 'mode-all', 'mode-allowlist-text', 'mode-all-text',
      'mode-consequence', 'program-list', 'advanced-summary', 'allowlist', 'allowlist-label', 'denylist', 'denylist-label',
      'pattern-error', 'now', 'after', 'no-programs-note', 'undo', 'apply'].map((id) => [id, node.querySelector(`#access-${id}`)]))
    // The pattern grammar sits behind "?" beside the first list and describes both.
    nodes['pattern-help'] = nc.help('', { describes: [nodes.allowlist, nodes.denylist] })
    nodes['pattern-help'].id = 'access-pattern-help'
    nodes['allowlist-label'].after(nodes['pattern-help'])
    for (const mode of ['allowlist', 'all']) nodes[`mode-${mode}`].onchange = () => change((draft) => { draft.mode = mode })
    for (const list of ['allowlist', 'denylist']) {
      nodes[list].oninput = () => change((draft) => { draft[list] = lines(nodes[list]) })
    }
    nodes.undo.onclick = () => {
      const view = access.view()
      if (view) { drafts.delete(view.executorId); access.render() }
    }
    nodes.apply.onclick = () => {
      const view = access.view()
      if (!view) return
      const policy = copy(draftOf(view))
      const applied = access.edit({ section: 'programs', target: nodes.apply.parentElement, immediately: true,
        inForce: (input) => t('save.inForce.programs', { rule: ruleWords(input.commandPolicy) }),
        mutate: (input) => { input.commandPolicy = policy } })
      if (applied) drafts.delete(view.executorId)
      access.render()
    }
    const dialog = document.createElement('dialog')
    dialog.id = 'access-program-dialog'
    dialog.setAttribute('aria-labelledby', 'access-program-dialog-title')
    dialog.innerHTML = '<h2 id="access-program-dialog-title" tabindex="-1"></h2><form><div class="label-row"><label for="access-program-name" id="access-program-name-label"></label></div>'
      + '<input id="access-program-name" maxlength="256" autocomplete="off" spellcheck="false" aria-errormessage="access-program-error">'
      + '<p id="access-program-error" class="field-error" role="alert" hidden></p>'
      + '<div class="actions"><button type="button" id="access-program-cancel"></button><button type="submit" id="access-program-confirm" class="primary"></button></div></form>'
    document.body.append(dialog)
    const input = dialog.querySelector('input')
    const addHelp = nc.help('', { describes: input })
    addHelp.id = 'access-program-help'
    dialog.querySelector('.label-row').append(addHelp)
    const error = dialog.querySelector('#access-program-error')
    dialog.querySelector('#access-program-cancel').onclick = () => dialog.close()
    dialog.querySelector('form').onsubmit = (event) => {
      event.preventDefault()
      const name = input.value.trim()
      const view = access.view()
      const taken = view ? draftOf(view).allowlist.some((rule) => programOf(rule) === name) : false
      const problem = !validName(name) ? 'programs.invalidName' : taken ? 'programs.duplicate' : null
      if (problem) {
        error.textContent = t(problem)
        error.hidden = false
        input.setAttribute('aria-invalid', 'true')
        return
      }
      dialog.close()
      change((draft) => { draft.allowlist = [...draft.allowlist, `${name} *`] })
    }
    nodes['add-program'].onclick = () => {
      for (const [id, key] of [['access-program-dialog-title', 'programs.addTitle'], ['access-program-name-label', 'programs.addName'],
        ['access-program-cancel', 'programs.cancel'], ['access-program-confirm', 'programs.addConfirm']]) {
        nc.byId(id).textContent = t(key)
      }
      addHelp.set(t('programs.addHint'))
      input.value = ''
      input.removeAttribute('aria-invalid')
      error.hidden = true
      dialog.lang = document.documentElement.lang
      dialog.showModal()
      input.focus()
    }
  }

  const renderList = (draft, saved) => access.keepFocus(nodes['program-list'], () => {
    const list = nodes['program-list']
    list.replaceChildren()
    const listed = draft.mode === 'allowlist'
    for (const entry of defaults(saved)) {
      const key = entry.id
      const name = t(`programs.builtins.${key}`)
      const toggle = access.toggle({ label: t('programs.switchLabel', { program: name }), checked: Boolean(draft.trusted?.[key]),
        disabled: !listed || !entry.available, onchange: (on) => setTrusted(key, on) })
      list.append(access.row({ name, detail: entry.available ? undefined : t('programs.unavailable'), control: toggle, key,
        disabled: !listed || !entry.available }))
    }
    for (const rule of draft.allowlist) {
      const program = programOf(rule) ?? rule
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = t('folders.remove')
      remove.disabled = !listed
      remove.setAttribute('aria-label', t('programs.removeLabel', { program }))
      remove.onclick = () => change((next) => { next.allowlist = next.allowlist.filter((entry) => entry !== rule) })
      list.append(access.row({ name: program, detail: t('programs.ownerAdded'), control: remove, key: rule, disabled: !listed }))
    }
  }, () => nodes['add-program'])

  const render = (view) => {
    const { saved } = view
    const draft = draftOf(view)
    const dirty = drafts.has(view.executorId) && !same(draft, saved.commandPolicy)
    const ok = valid(draft)
    nc.byId('access-programs-title').textContent = t('sections.programs')
    nodes['add-program'].textContent = t('programs.add')
    nodes['add-program'].disabled = draft.mode !== 'allowlist'
    nodes['mode-label'].textContent = t('programs.modeLabel')
    nodes['mode-allowlist-text'].textContent = t('programs.modeOnly')
    nodes['mode-all-text'].textContent = t('programs.modeAny')
    nodes['mode-consequence'].textContent = t('programs.consequence')
    nodes[`mode-${draft.mode}`].checked = true
    renderList(draft, saved)
    nodes['advanced-summary'].textContent = t('programs.advanced')
    nodes['allowlist-label'].textContent = t('programs.allowed')
    nodes['denylist-label'].textContent = t('programs.blocked')
    nodes['pattern-help'].set(t('programs.help'))
    // A field being typed in is never repainted under the person's hands.
    for (const list of ['allowlist', 'denylist']) {
      if (document.activeElement !== nodes[list]) nodes[list].value = draft[list].join('\n')
      nodes[list].setAttribute('aria-invalid', String(!draft[list].every(validRule)))
    }
    nodes['pattern-error'].hidden = ok
    nodes['pattern-error'].textContent = t('programs.invalidPatterns')
    nodes.now.textContent = t('programs.now', { rule: ruleWords(saved.commandPolicy) })
    nodes.after.textContent = dirty ? t('programs.after', { rule: ruleWords(draft) }) : t('programs.noChanges')
    nodes['no-programs-note'].hidden = !(dirty && draft.mode === 'allowlist' && ruleWords(draft) === t('programs.noPrograms'))
    nodes['no-programs-note'].textContent = t('programs.noProgramsNote')
    nodes.undo.textContent = t('programs.undo')
    nodes.undo.hidden = !drafts.has(view.executorId)
    nodes.apply.textContent = t('programs.apply')
    nodes.apply.disabled = !dirty || !ok
    // With nothing changed the switches above already say what is allowed.
    nodes.apply.closest('.access-apply').hidden = !dirty && !drafts.has(view.executorId)
  }

  access.register('programs', { build, render })
})()
