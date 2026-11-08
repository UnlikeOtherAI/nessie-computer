// Now working (contract §11.5): one row per session — "{agent} · {team}" —
// its commands beneath in plain words, and Stop per session with a short
// confirm. Read from `executor_sessions` while Overview is showing; rows are
// updated in place so a refresh never moves the page under the person.
(() => {
  const nc = window.nc
  const { byId, invoke, t, attempt } = nc
  const REFRESH_MS = 3000
  let sessions = []
  let loadedAt = 0
  let stopping = null

  // ---- one command, in plain words; the program or path sits in <code>
  const withCode = (key, name, value, vars = {}) => {
    const fragment = document.createDocumentFragment()
    const [before, after] = t(key, { ...vars, [name]: '\u0000' }).split('\u0000')
    const code = document.createElement('code')
    code.textContent = value
    fragment.append(before, code, after ?? '')
    return fragment
  }
  const programText = (command) => [command.program, ...(Array.isArray(command.args) ? command.args : [])].filter(Boolean).join(' ')
  const site = (command) => { try { return new URL(command.site).host } catch { return command.site } }
  const describe = (command) => {
    if (command.kind === 'program' && command.program) return withCode('working.running', 'program', programText(command))
    if (command.kind === 'file' && command.path) return withCode(command.operation === 'write' ? 'working.writing' : 'working.reading', 'path', command.path)
    if (command.kind === 'coding') return command.program ? withCode('working.coding', 'program', command.program) : t('working.codingUnknown')
    if (command.kind === 'browser') return command.site ? withCode('working.browsing', 'site', site(command)) : t('working.browsingUnknown')
    if (command.kind === 'mcp' && command.app) return withCode('working.usingApp', 'app', command.app)
    return t('working.working')
  }
  const wrapStatus = (command, what) => {
    if (command.status !== 'waiting_for_owner' && command.status !== 'queued') return what
    const fragment = document.createDocumentFragment()
    const key = command.status === 'queued' ? 'working.waitingToStart' : 'working.waitingForYou'
    const [before, after] = t(key, { what: '\u0000' }).split('\u0000')
    fragment.append(before, what, after ?? '')
    return fragment
  }
  // A command waiting for the owner links to its request under Needs you.
  const answerLink = (command) => {
    const link = document.createElement('button')
    link.className = 'link'
    link.textContent = t('working.answer')
    link.dataset.key = `${command.id}:answer`
    link.onclick = () => {
      const request = byId('needs-you-list').querySelector(`[data-request="${CSS.escape(command.requestId)}"]`) ?? byId('overview-needs-title')
      request.scrollIntoView({ block: 'nearest' })
      ;(request.querySelector('button') ?? request).focus()
    }
    return link
  }
  const commandRow = (command) => {
    const row = document.createElement('li')
    row.className = `command command-${command.status ?? 'running'}`
    row.dataset.command = command.id
    const text = document.createElement('span')
    text.append(wrapStatus(command, describe(command)))
    row.append(text)
    if (command.status === 'waiting_for_owner' && command.requestId) row.append(' ', answerLink(command))
    return row
  }

  // ---- one session
  const agentOf = (session) => session.agentName || t('working.unknownAgent')
  const label = (session) => `${agentOf(session)} · ${nc.team.label(session.executorId)}`
  const sessionRow = (session) => {
    const row = document.createElement('li')
    row.className = 'session'
    row.dataset.session = session.sessionId
    const head = document.createElement('div')
    head.className = 'session-head'
    const title = document.createElement('h3')
    title.className = 'session-title'
    const stop = document.createElement('button')
    stop.className = 'session-stop'
    stop.dataset.key = `${session.sessionId}:stop`
    stop.onclick = () => openStop(session)
    head.append(title, stop)
    const commands = document.createElement('ul')
    commands.className = 'commands'
    row.append(head, commands)
    return row
  }
  const fillSession = (row, session) => {
    row.querySelector('.session-title').textContent = label(session)
    const stop = row.querySelector('.session-stop')
    stop.textContent = t('working.stop')
    stop.setAttribute('aria-label', `${t('working.stop')} ${label(session)}`)
    const commands = Array.isArray(session.commands) ? session.commands : []
    row.querySelector('.commands').replaceChildren(...commands.map(commandRow))
  }

  /** Rows keep their place: a session already shown is updated where it is, new ones are appended, gone ones removed. */
  const render = () => {
    const section = byId('overview-working')
    const teams = nc.team.teams()
    section.hidden = !teams.length
    if (!teams.length) return
    const list = byId('working-list')
    byId('working-empty').hidden = sessions.length > 0
    list.hidden = !sessions.length
    nc.keepFocus(list, () => {
      const existing = new Map([...list.children].map((row) => [row.dataset.session, row]))
      for (const session of sessions) {
        const row = existing.get(session.sessionId) ?? sessionRow(session)
        existing.delete(session.sessionId)
        fillSession(row, session)
        list.append(row)
      }
      for (const row of existing.values()) row.remove()
    })
  }

  // ---- Stop asks first; the dialog cannot be dismissed while the stop runs
  const openStop = (session) => {
    stopping = session
    byId('stop-session-title').textContent = t('working.stopTitle', { agent: agentOf(session) })
    byId('stop-session-body').textContent = t('working.stopBody')
    byId('stop-session-confirm').textContent = t('working.stop')
    nc.dialogs.open('stop-session-dialog')
    byId('stop-session-cancel').focus()
  }
  byId('stop-session-cancel').textContent = t('shell.cancel')
  byId('stop-session-dialog').addEventListener('cancel', (event) => { if (byId('stop-session-confirm').disabled) event.preventDefault() })
  byId('stop-session-confirm').onclick = () => attempt(async () => {
    const session = stopping
    const [confirm, cancel] = [byId('stop-session-confirm'), byId('stop-session-cancel')]
    confirm.disabled = cancel.disabled = true
    confirm.textContent = t('working.stopping')
    try {
      const next = await invoke('executor_stop_session', { executorId: session.executorId, sessionId: session.sessionId })
      byId('stop-session-dialog').close()
      sessions = Array.isArray(next) ? next : sessions.filter((entry) => entry.sessionId !== session.sessionId)
      loadedAt = Date.now()
      render()
      nc.footer.note(t('working.stopped', { agent: agentOf(session) }))
      ;(byId('working-list').querySelector('.session-stop') ?? byId('overview-working-title')).focus()
    } finally {
      confirm.disabled = cancel.disabled = false
      confirm.textContent = t('working.stop')
    }
  })

  // ---- reading the host
  const load = async () => {
    if (!nc.team.teams().length) { sessions = []; render(); return }
    try {
      const answer = await invoke('executor_sessions', {})
      sessions = Array.isArray(answer) ? answer : []
      nc.clearError(byId('working-error'))
    } catch {
      nc.reportError(new Error(t('working.refreshFailed')), byId('working-error'))
    }
    loadedAt = Date.now()
    render()
  }

  byId('overview-working-title').textContent = t('working.title')
  byId('working-empty').textContent = t('working.empty')

  nc.working = { refresh: load, sessions: () => sessions }
  nc.team.onListChange(() => { render(); load().catch(() => undefined) })
  nc.view.onChange((tab) => { if (tab === 'overview') load().catch(() => undefined) })
  window.addEventListener('DOMContentLoaded', () => {
    setInterval(() => {
      if (nc.view.current() !== 'overview' || Date.now() - loadedAt < REFRESH_MS - 500) return
      load().catch(() => undefined)
    }, REFRESH_MS)
    render()
  })
})()
