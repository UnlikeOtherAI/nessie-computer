const nativeHost = 'works.nessie.executor.browser_import'
const content = document.querySelector('#content')

let offer = null
let port = null

const status = (message) => {
  content.replaceChildren()
  const paragraph = document.createElement('p')
  paragraph.id = 'status'
  paragraph.textContent = message
  content.append(paragraph)
}

const permissionPattern = (origin) => `${new URL(origin).origin}/*`

const copyCookie = (cookie) => ({
  domain: cookie.domain,
  expirationDate: cookie.expirationDate,
  hostOnly: cookie.hostOnly,
  httpOnly: cookie.httpOnly,
  name: cookie.name,
  path: cookie.path,
  sameSite: cookie.sameSite,
  secure: cookie.secure,
  session: cookie.session,
  value: cookie.value,
})

/** Keep only cookies which Chrome would send to this exact selected host. */
const appliesToSelectedHost = (cookie, origin) => {
  const host = new URL(origin).hostname.toLowerCase()
  const domain = cookie.domain.replace(/^\./, '').toLowerCase()
  return cookie.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`)
}

const selectedOrigins = () => [...content.querySelectorAll('input[type="checkbox"]:checked')]
  .map((input) => input.value)

const renderOffer = () => {
  if (!offer) return
  content.replaceChildren()
  const description = document.createElement('p')
  description.textContent = `Copy sessions into ${offer.destination.agentName} for ${offer.destination.userName}. ${offer.destination.retention}`
  content.append(description)
  const explanation = document.createElement('p')
  explanation.textContent = 'Choose each HTTPS site to copy. Nessie never receives passwords, history, or your whole browser profile. Some services also need their separate sign-in site selected.'
  content.append(explanation)
  const sites = document.createElement('fieldset')
  const legend = document.createElement('legend')
  legend.textContent = 'Sites to import'
  sites.append(legend)
  for (const origin of offer.origins) {
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = origin
    checkbox.addEventListener('change', updateImportButton)
    label.append(checkbox, document.createTextNode(` ${origin}`))
    sites.append(label)
  }
  content.append(sites)
  const importButton = document.createElement('button')
  importButton.type = 'button'
  importButton.id = 'import'
  importButton.disabled = true
  importButton.textContent = 'Import selected sites'
  importButton.addEventListener('click', () => { void importSelectedSites() })
  content.append(importButton)
}

const updateImportButton = () => {
  const button = content.querySelector('#import')
  if (button) button.disabled = selectedOrigins().length === 0
}

const importSelectedSites = async () => {
  if (!offer || !port) return
  const origins = selectedOrigins()
  if (origins.length === 0) return
  const patterns = origins.map(permissionPattern)
  const button = content.querySelector('#import')
  if (button) button.disabled = true
  try {
    const granted = await chrome.permissions.request({ origins: patterns, permissions: ['cookies'] })
    if (!granted) {
      status('Chrome did not grant access to the selected sites. Nothing was imported.')
      return
    }
    const imports = []
    for (const origin of origins) {
      // `getAll({url})` hides cookies below the root path. Read only from the
      // extension's just-granted selected-host permissions, then retain the
      // entries Chrome would send to this selected host at any safe path.
      const cookies = (await chrome.cookies.getAll({})).filter((cookie) => appliesToSelectedHost(cookie, origin))
      if (cookies.some((cookie) => cookie.partitionKey !== undefined)) {
        status('This site has partitioned cookies, which this first import does not support. Sign in manually in Nessie instead.')
        return
      }
      imports.push({ cookies: cookies.map(copyCookie), origin })
    }
    port.postMessage({
      cookies: { imports, version: 1 },
      requestId: offer.requestId,
      selectedOrigins: origins,
      type: 'browser_cookie_import.submit.v1',
    })
    status('Importing the selected site sessions…')
  } catch {
    status('The selected sites could not be imported. Sign in manually in Nessie instead.')
  } finally {
    await chrome.permissions.remove({ origins: patterns, permissions: ['cookies'] }).catch(() => undefined)
  }
}

const handleNativeMessage = (frame) => {
  if (frame?.type === 'browser_cookie_import.offer.v1') {
    offer = frame
    renderOffer()
    return
  }
  if (frame?.type === 'browser_cookie_import.accepted.v1') {
    status('Imported. Nessie will verify the selected sites when it next opens this private browser.')
    return
  }
  status('No import is ready, or it expired. Start a new import from Nessie.')
}

try {
  port = chrome.runtime.connectNative(nativeHost)
  port.onDisconnect.addListener(() => {
    if (!offer) status('The Nessie desktop companion is unavailable. Start the import again after it is running.')
  })
  port.onMessage.addListener(handleNativeMessage)
  port.postMessage({ type: 'browser_cookie_import.hello.v1' })
} catch {
  status('The Nessie desktop companion is unavailable. Start the import again after it is running.')
}
