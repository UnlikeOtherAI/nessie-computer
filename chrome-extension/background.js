// This extension is intentionally a typed native-messaging client, not a CDP
// proxy. Release packaging pins its extension ID in the native-host manifest.
const nativeHost = 'works.nessie.executor.browser'
let port = null
let tabId = null

const clear = async () => {
  if (tabId !== null) await chrome.debugger.detach({ tabId }).catch(() => undefined)
  tabId = null
  port?.disconnect()
  port = null
  await chrome.action.setBadgeText({ text: '' })
}

const post = (frame) => port?.postMessage(frame)

const attachCurrentTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/^https:\/\//.test(tab.url ?? '')) return
  await clear()
  tabId = tab.id
  port = chrome.runtime.connectNative(nativeHost)
  port.onDisconnect.addListener(() => { void clear() })
  port.onMessage.addListener((frame) => { void handleNativeFrame(frame) })
  await chrome.debugger.attach({ tabId }, '1.3')
  await chrome.action.setBadgeText({ text: 'ON', tabId })
  await chrome.action.setBadgeBackgroundColor({ color: '#b45309', tabId })
  post({ type: 'connected_browser.tab_selected', tabId })
}

const handleNativeFrame = async (frame) => {
  // The daemon only sends a closed command vocabulary. Never forward a method,
  // script, selector, or raw DevTools payload from native messaging.
  if (!frame || frame.type === 'connected_browser.stop') return clear()
  if (typeof frame?.type !== 'string' || !['connected_browser.observe', 'connected_browser.act'].includes(frame.type) || tabId === null) return
  // A production build maps this closed request to dedicated extension handlers
  // and returns a bounded frame. It must never relay arbitrary CDP commands.
  post({ type: 'connected_browser.rejected', reason: 'typed_handler_unavailable' })
}

chrome.action.onClicked.addListener(() => { void attachCurrentTab() })
chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (closedTabId === tabId) { post({ type: 'connected_browser.stopped' }); void clear() }
})
