// Every setting saves as soon as it changes; there are no Save buttons. Saves
// run one at a time and in order — applying one restarts that team's local
// connection — while the page stays usable. Typing is debounced per field
// group, and leaving a field, switching team or closing flushes what is left.
const autosave = (() => {
  const timers = new Map()
  const idleListeners = []
  let chain = Promise.resolve()
  let queued = 0
  const idle = () => queued === 0 && timers.size === 0
  const enqueue = (run) => {
    queued += 1
    const next = chain.then(run).finally(() => {
      queued -= 1
      // Once nothing is running or waiting, whatever finished last is reported once.
      if (idle()) for (const listener of idleListeners) listener()
    })
    chain = next.catch(() => undefined)
    return next
  }
  const cancel = (key) => {
    const pending = timers.get(key)
    if (pending) clearTimeout(pending.timeout)
    timers.delete(key)
    return pending
  }
  return {
    /** Save after typing pauses. A newer edit to the same group replaces the older one. */
    schedule: (key, run, delay = 900) => {
      cancel(key)
      timers.set(key, { run, timeout: setTimeout(() => { timers.delete(key); enqueue(run) }, delay) })
    },
    /** Drop a pending save the person has since made incomplete. */
    cancel: (key) => { cancel(key) },
    /** Save now, replacing any pending save for the same group. */
    now: (key, run) => { cancel(key); return enqueue(run) },
    /** Start every pending save now and resolve once all of them have finished. */
    flush: () => {
      for (const key of [...timers.keys()]) enqueue(cancel(key).run)
      return chain
    },
    /** Called each time the queue drains. */
    onIdle: (listener) => { idleListeners.push(listener) },
  }
})()
