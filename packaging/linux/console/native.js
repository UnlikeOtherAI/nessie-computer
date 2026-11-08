// A process-local WebKitGTK bridge. The native host accepts only fixed update operations.
(() => {
  let serial = 0
  const pending = new Map()
  window.executorLinuxReply = (id, value, failed) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    clearTimeout(request.timeout)
    if (failed) request.reject(new Error('update.coordinator_unavailable'))
    else request.resolve(value)
  }
  window.executorNative = {
    platform: 'linux',
    invoke: (command, args = {}) => new Promise((resolve, reject) => {
      const id = ++serial
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('update.coordinator_unavailable'))
      }, 20_000)
      pending.set(id, { resolve, reject, timeout })
      window.webkit.messageHandlers.executor.postMessage({ id, command, args })
    }),
    listen: (event, handler) => {
      const receive = (message) => handler(message.detail ?? null)
      window.addEventListener(event, receive)
      return Promise.resolve(() => window.removeEventListener(event, receive))
    },
  }
})()
