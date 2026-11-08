// A stand-in for the console shell (tranche E1) while the team tabs are built
// against contract §5.3: the tab strip, the team dropdown, the three empty
// team panels and `window.nc` exactly as the contract names it. Only this file
// pretends; the scripts under test are the shipped console modules.
export const TEAM_TAB_FILES = ['style.css', 'native.js', 'autosave.js', 'team-drafts.js', 'access.js', 'access-words.js', 'access-sections.js',
  'access-programs.js', 'documents-reasons-words.js', 'documents-words.js', 'documents.js', 'ai.js', 'ai-words.js', 'chatgpt.js',
  'chatgpt-words.js', 'inference-endpoints.js']

const shim = String.raw`
window.nc = (() => {
  const byId = (id) => document.getElementById(id)
  const tables = {}
  const LOCALES = ['en-GB', 'en-US', 'cs', 'de', 'es', 'fr', 'it']
  const wanted = navigator.language
  const locale = LOCALES.find((name) => name.toLowerCase() === wanted.toLowerCase())
    ?? LOCALES.find((name) => name.split('-')[0] === wanted.toLowerCase().split('-')[0]) ?? 'en-GB'
  document.documentElement.lang = locale
  const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
  const t = (key, vars) => {
    const [namespace, ...path] = key.split('.')
    const value = path.reduce((node, part) => node?.[part], tables[namespace]?.[locale])
    if (typeof value !== 'string') { (window.missingWords ??= []).push(key); return key }
    return fill(value, vars)
  }
  const teamListeners = []
  const viewListeners = []
  let currentView = 'access'
  const label = (executorId) => {
    const names = window.teamNames?.[executorId]
    return names ? names.teamName + ' · ' + names.organizationName : 'Team name not available yet'
  }
  const select = byId('connection')
  const describes = new Map()
  select.onchange = () => { describes.clear(); for (const fn of teamListeners) fn(select.value) }
  const errorSlot = (target) => {
    if (!target) return byId('error')
    const node = typeof target === 'string' ? byId(target) : target
    let slot = node.nextElementSibling
    if (!slot?.classList.contains('attempt-error')) {
      slot = document.createElement('p')
      slot.className = 'field-error attempt-error'
      slot.setAttribute('role', 'alert')
      node.parentElement.insertBefore(slot, node.nextSibling)
    }
    return slot
  }
  const showView = (name) => {
    currentView = name
    for (const tab of document.querySelectorAll('[role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
    for (const panel of ['access', 'documents', 'ai']) byId('tab-' + panel).hidden = panel !== name
    byId('team-row').hidden = !['access', 'documents', 'ai'].includes(name)
    for (const fn of viewListeners) fn(name)
  }
  for (const tab of document.querySelectorAll('[role=tab]')) tab.onclick = () => showView(tab.dataset.tab)
  return {
    byId,
    invoke: (command, args) => window.executorNative.invoke(command, args),
    listen: (event, handler) => window.executorNative.listen(event, handler),
    attempt: (fn, { target } = {}) => Promise.resolve().then(fn).catch((error) => {
      const slot = errorSlot(target)
      slot.textContent = String(error?.message ?? error)
      slot.hidden = false
    }),
    t,
    words: { register: (namespace, table) => { tables[namespace] = table }, locale },
    team: {
      current: () => select.value || null,
      label,
      onChange: (fn) => { teamListeners.push(fn) },
      describe: () => {
        const executorId = select.value
        if (!describes.has(executorId)) {
          const read = window.executorNative.invoke('executor_describe', { executorId })
          read.catch(() => describes.delete(executorId))
          describes.set(executorId, read)
        }
        return describes.get(executorId)
      },
    },
    view: { onChange: (fn) => { viewListeners.push(fn) }, current: () => currentView, show: showView },
    dialogs: { open: (id) => byId(id).showModal() },
    setTeams: (teams) => {
      select.replaceChildren(...teams.map((executorId) => Object.assign(document.createElement('option'), { value: executorId, textContent: label(executorId) })))
      select.value = teams[0] ?? ''
      describes.clear()
      for (const fn of teamListeners) fn(select.value)
    },
  }
})()
`

export const teamTabsHtml = () => `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nessie Computer</title>
<link rel="stylesheet" href="style.css"></head>
<body>
<header><div class="title-row"><h1>Nessie Computer</h1></div>
<div class="team-row" id="team-row"><label for="connection">Team:</label><select id="connection"></select></div></header>
<div class="tabs" role="tablist" aria-label="Nessie Computer">
  <button role="tab" data-tab="access" aria-selected="true">Access</button>
  <button role="tab" data-tab="documents" aria-selected="false">Documents</button>
  <button role="tab" data-tab="ai" aria-selected="false">AI</button>
</div>
<p id="error" role="alert" hidden></p>
<main>
  <section id="tab-access" role="tabpanel"></section>
  <section id="tab-documents" role="tabpanel" hidden></section>
  <section id="tab-ai" role="tabpanel" hidden></section>
</main>
<footer><div id="save-status" role="status"></div></footer>
<script src="native.js"></script>
<script>${shim}</script>
${TEAM_TAB_FILES.filter((file) => !['style.css', 'native.js'].includes(file)).map((file) => `<script src="${file}"></script>`).join('\n')}
<script>window.nc.setTeams(window.paired.map((row) => row.executorId))</script>
</body></html>`
