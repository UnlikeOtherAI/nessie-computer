// The Access tab: what the team chosen in the dropdown may use on this
// computer — Folders, Programs, Websites, Local apps and, for developers,
// Coding assistants. Each section registers itself here (access-sections.js,
// access-programs.js); this file owns the tab's frame, its loading state and
// the moment every section repaints.
window.accessTab = (() => {
  const nc = window.nc
  const sections = new Map() // name → { build(section), render(view) }
  const tab = nc.byId('tab-access')
  let built = false
  let loading = null // the team whose access is being read
  let failed = null // { executorId, reason }
  let savedTimer = null
  const t = (key, vars) => nc.t(`access.${key}`, vars)

  // Team-tab rules that style.css does not carry yet; one block, the shell's tokens.
  const style = document.createElement('style')
  style.textContent = `
    .access-section { padding: 14px 0 18px; border-bottom: 1px solid var(--line); }
    .access-section:last-of-type { border-bottom: 0; }
    .access-section h3 { font-size: 15px; margin: 0; }
    .access-section .section-heading { margin-bottom: 4px; }
    .access-section .intro { margin: 4px 0 10px; }
    .access-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .access-row:last-child { border-bottom: 0; }
    .access-row .access-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .access-row .access-name small { display: block; color: var(--muted); }
    .access-row[aria-disabled=true] .access-name { color: var(--muted); }
    .access-row .switch .track { pointer-events: none; }
    .access-mode { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin: 6px 0 2px; }
    .access-mode .toggle { margin: 0; font-weight: 400; white-space: nowrap; align-items: center; }
    .access-mode .toggle input { margin: 0; }
    .access-mode .hint { flex-basis: 100%; margin: 0; }
    .access-apply { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 12px; padding: 10px 12px; background: var(--soft); border-radius: 8px; }
    .access-apply .access-lines { flex: 1 1 220px; min-width: 0; }
    .access-apply p { margin: 0; overflow-wrap: anywhere; }
    .access-current { font-weight: 600; margin: 0 0 6px; overflow-wrap: anywhere; }
    .access-note { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
    .access-saved { color: var(--on); font-size: 12px; margin-left: 10px; font-weight: 400; }
    details.access-developers { margin-top: 8px; }
    details.access-developers summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
    .access-section textarea { min-height: 64px; }
    .save-problem button { padding: 2px 8px; font-size: 12px; }
    #access-status { color: var(--muted); }
    #access-status button { padding: 2px 8px; font-size: 12px; }
    @media (max-width: 470px) { .access-row { flex-wrap: wrap; } .access-row .access-name { flex-basis: 100%; } .access-row button, .access-mode .toggle { min-height: 44px; } }
  `
  document.head.append(style)

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
    heading.className = 'section-heading'
    heading.innerHTML = '<h2 id="access-heading"></h2><span id="access-saved" class="access-saved" role="status"></span>'
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
    nc.byId('access-heading').textContent = t('heading', { team: label })
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
      if (executorId === current()) failed = { executorId, reason: error?.message ?? String(error) }
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
      row.className = 'access-row'
      if (disabled) row.setAttribute('aria-disabled', 'true')
      const text = document.createElement('div')
      text.className = 'access-name'
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
    /** Rebuilding a list keeps keyboard focus on the same row's control, or moves it somewhere deliberate. */
    keepFocus: (container, rebuild, fallback) => {
      const key = container.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
      rebuild()
      if (key === undefined) return
      const again = [...container.querySelectorAll('[data-key]')].find((node) => node.dataset.key === key && !node.disabled)
      ;(again ?? fallback()).focus()
    },
    /** The words for a list of names, or "none". */
    list: (names) => (names.length ? names.join(', ') : t('none')),
  }
})()
