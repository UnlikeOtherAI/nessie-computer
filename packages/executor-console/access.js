// The Access tab: what the team chosen in the dropdown may use on this
// computer — Folders, Programs, Websites, Local apps and, for developers,
// Coding assistants. Each section registers itself here (access-sections.js,
// access-programs.js); this file owns the tab's frame, its loading state and
// the moment every section repaints.
window.accessTab = (() => {
  const nc = window.nc
  const teamDrafts = window.teamDrafts
  const sections = new Map() // name → { build(section), render(view) }
  const tab = nc.byId('tab-access')
  let built = false
  let loading = null // the team whose access is being read
  let failed = null // { executorId, reason }
  let savedTimer = null
  const t = (key, vars) => nc.t(`access.${key}`, vars)

  const current = () => nc.team.current()
  /** The configuration the sections paint: the draft while one waits, otherwise what is saved. */
  const view = () => {
    const executorId = current()
    const saved = executorId ? teamDrafts.saved(executorId) : null
    return saved ? { executorId, saved, input: teamDrafts.shown(executorId), label: nc.team.label(executorId) } : null
  }

  const build = () => {
    if (built) return
    built = true
    tab.replaceChildren()
    const heading = document.createElement('div')
    heading.className = 'saved-row'
    heading.innerHTML = '<span id="access-saved" class="saved-note" role="status"></span>'
    const status = document.createElement('p')
    status.id = 'access-status'
    status.setAttribute('role', 'status')
    status.hidden = true
    status.innerHTML = '<span id="access-status-text"></span> <button type="button" id="access-reload" hidden></button>'
    const body = document.createElement('div')
    body.id = 'access-body'
    tab.append(heading, status, body)
    // Contract §3.2 order, whatever order the section scripts loaded in.
    for (const name of ['folders', 'programs', 'websites', 'localApps', 'coding']) {
      const section = sections.get(name)
      if (!section) continue
      const node = document.createElement('section')
      node.className = 'access-section'
      node.id = `access-${name}`
      node.setAttribute('aria-labelledby', `access-${name}-title`)
      body.append(node)
      section.build(node)
    }
    nc.byId('access-reload').onclick = () => nc.attempt(() => load({ fresh: true }))
  }

  const render = () => {
    build()
    const executorId = current()
    const label = executorId ? nc.team.label(executorId) : ''
    nc.byId('access-reload').textContent = t('save.tryAgain')
    const shown = view()
    const busy = loading === executorId && !shown
    const failure = failed?.executorId === executorId ? failed.reason : null
    nc.byId('access-status').hidden = Boolean(shown) || (!busy && !failure)
    nc.byId('access-status-text').textContent = failure ? `${t('loadFailed', { team: label })} ${failure}`
      : busy ? t('loading', { team: label }) : ''
    nc.byId('access-reload').hidden = !failure
    nc.byId('access-body').hidden = !shown
    if (!shown) return
    for (const section of sections.values()) section.render(shown)
  }

  /** Reads the chosen team's access, once per selection; a failure says so and offers Try again. */
  const load = async ({ fresh = false } = {}) => {
    const executorId = current()
    if (!executorId || nc.view.current() !== 'access') { render(); return }
    if (teamDrafts.saved(executorId)) { render(); return }
    loading = executorId
    failed = null
    render()
    try {
      await teamDrafts.describe(executorId, { fresh })
    } catch (error) {
      if (executorId === current()) failed = { executorId, reason: nc.failure.sentence(error).text }
    } finally {
      if (loading === executorId) loading = null
      render()
    }
  }

  const flashSaved = (executorId) => {
    if (executorId !== current()) return
    const note = nc.byId('access-saved')
    note.textContent = t('save.saved')
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { note.textContent = '' }, 3000)
  }

  // A selection reads the team afresh: a program request answered or a live-applied revision may have changed it.
  nc.team.onChange((executorId) => {
    failed = null
    if (executorId && !teamDrafts.hasDraft(executorId)) teamDrafts.forget(executorId)
    nc.attempt(load)
  })
  nc.view.onChange((name) => { if (name === 'access') nc.attempt(load) })
  teamDrafts.onChanged((executorId) => { if (executorId === current() && nc.view.current() === 'access') render() })
  teamDrafts.onSaved(flashSaved)
  // Another describe (a program request answered, a live-applied revision) is picked up when the tab is shown again.
  document.addEventListener('DOMContentLoaded', () => nc.attempt(load))

  return {
    /** A section registers once, before the first render; `build` makes its controls, `render(view)` paints them. */
    register: (name, section) => { sections.set(name, section) },
    render, view, current, t,
    /** A control's edit to the team's draft; false when nothing changed. */
    edit: (options) => {
      const executorId = current()
      return executorId ? teamDrafts.edit(executorId, options) : false
    },
    /** Rows a list paints: a name, a detail line and one control on the right. */
    row: ({ name, detail, control, key, disabled = false }) => {
      const row = document.createElement('div')
      row.className = 'list-row'
      if (disabled) row.setAttribute('aria-disabled', 'true')
      const text = document.createElement('div')
      text.className = 'list-name'
      text.textContent = name
      if (detail) {
        const small = document.createElement('small')
        small.textContent = detail
        text.append(small)
      }
      if (key && control) control.dataset.key = key
      row.append(text)
      if (control) row.append(control)
      return row
    },
    /** A switch with an accessible name of its own. */
    toggle: ({ label, checked, disabled = false, onchange }) => {
      const wrapper = document.createElement('label')
      wrapper.className = 'switch'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.setAttribute('role', 'switch')
      input.setAttribute('aria-label', label)
      input.checked = checked
      input.disabled = disabled
      input.onchange = () => onchange(input.checked, input)
      const track = document.createElement('span')
      track.className = 'track'
      track.setAttribute('aria-hidden', 'true')
      wrapper.append(input, track)
      return wrapper
    },
    keepFocus: nc.keepFocus,
    /** The words for a list of names, or "none". */
    list: (names) => (names.length ? names.join(', ') : t('none')),
  }
})()
