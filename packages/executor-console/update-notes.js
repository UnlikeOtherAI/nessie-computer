// Public, display-only release notes. This reader cannot select or install software.
(() => {
  const nc = window.nc
  const node = (id) => document.getElementById(`update-notes-${id}`)
  const words = (key) => nc.t(`updates.${key}`)
  const version = (value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')
    ? value.split('.').map(Number) : null
  const compare = (a, b) => a.map((part, index) => part - b[index]).find((part) => part !== 0) ?? 0
  let selection = null
  let page = 1
  let generation = 0
  let controller = null
  let expanded = false
  let busy = false
  let finished = false
  const seen = new Set()

  const buttons = () => {
    node('toggle').textContent = words(expanded ? 'hideNotes' : 'showNotes')
    node('toggle').setAttribute('aria-expanded', String(expanded))
    node('panel').hidden = !expanded
    node('more').hidden = finished
    node('more').disabled = busy
    node('more').textContent = words('moreNotes')
    node('retry').textContent = words('retryNotes')
  }

  const load = async () => {
    if (busy || finished || !selection) return
    const current = ++generation
    busy = true
    node('retry').hidden = true
    node('status').textContent = words('loadingNotes')
    buttons()
    const request = new window.AbortController()
    controller = request
    const timeout = setTimeout(() => request.abort(), 8000)
    try {
      // Fixed public origin, no account credentials, no redirects or caller-supplied URLs.
      const response = await window.fetch(
        `https://api.github.com/repos/UnlikeOtherAI/nessie-computer/releases?per_page=10&page=${page}`,
        { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: request.signal,
          headers: { Accept: 'application/vnd.github+json' } })
      if (!response.ok) throw new Error('notes unavailable')
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1_000_000) { await reader.cancel(); throw new Error('notes too large') }
        chunks.push(value)
      }
      const bytes = new window.Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const releases = JSON.parse(new window.TextDecoder().decode(bytes))
      if (!Array.isArray(releases) || releases.length > 10) throw new Error('invalid notes')
      if (current !== generation) return
      const installed = version(selection.installedVersion)
      const target = version(selection.availableVersion)
      if (!installed || !target) throw new Error('invalid version')
      const entries = releases.filter((release) => {
        const candidate = version(release.tag_name?.replace(/^executor-v/, ''))
        return release.tag_name?.startsWith('executor-v') && candidate && !release.draft && release.immutable === true
          && (!release.prerelease || selection.channel === 'preview')
          && compare(candidate, installed) > 0 && compare(candidate, target) <= 0
      }).sort((a, b) => compare(version(b.tag_name.slice(10)), version(a.tag_name.slice(10))))
      for (const release of entries) {
        if (seen.has(release.tag_name)) continue
        const article = document.createElement('article')
        article.lang = 'en'
        const heading = document.createElement('h3')
        heading.textContent = release.tag_name.slice(10)
        const body = document.createElement('p')
        // Release content is never interpreted as HTML or given access to the native bridge.
        body.textContent = typeof release.body === 'string' && release.body.trim() ? release.body : words('emptyNotes')
        article.append(heading, body)
        node('entries').append(article)
        seen.add(release.tag_name)
      }
      page++ // A failed or cancelled page never advances the reader.
      finished = releases.length < 10
      node('status').textContent = seen.size ? '' : words(finished ? 'emptyNotes' : 'olderNotes')
    } catch {
      if (current !== generation) return
      node('status').textContent = words('failedNotes')
      node('retry').hidden = false
    } finally {
      clearTimeout(timeout)
      if (current === generation) { busy = false; controller = null; buttons() }
    }
  }

  node('toggle').onclick = () => {
    expanded = !expanded
    buttons()
    if (expanded && page === 1) load()
  }
  node('more').onclick = node('retry').onclick = load
  nc.updateNotes = {
    reset: (status) => {
      ++generation
      controller?.abort()
      controller = null
      selection = status
      page = 1
      expanded = busy = finished = false
      seen.clear()
      node('entries').replaceChildren()
      node('status').textContent = ''
      node('retry').hidden = true
      buttons()
    },
  }
  document.getElementById('update-dialog').addEventListener('close', () => nc.updateNotes.reset(null))
  buttons()
})()
