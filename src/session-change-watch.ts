import { stat } from 'node:fs/promises'

/**
 * How the daemon hears that a coding session changed on this computer. Session
 * hosts are separate processes, and file-system events are unreliable on the
 * volumes this runs from, so every host replaces one marker file whenever a
 * session's status or pending requests change (`session-change-marker.ts`) and
 * the daemon looks at that one file's identity a few times a second — a single
 * `stat`, and nothing else, until it moves.
 *
 * A burst of changes (a turn ends and a request opens in the same instant)
 * becomes one call after a short debounce. The first look only records where
 * the marker stands: the daemon reports every session when it starts anyway.
 */
export const watchSessionChanges = (input: {
  /** The marker file, or undefined while no bridge is configured. */
  path: () => string | undefined
  onChange: () => void
  intervalMs?: number
  debounceMs?: number
}): { stop: () => void } => {
  let seen: string | undefined
  let checking = false
  let debounce: NodeJS.Timeout | undefined
  const check = async (): Promise<void> => {
    const path = input.path()
    if (!path || checking) return
    checking = true
    try {
      const info = await stat(path).catch(() => undefined)
      const identity = info ? `${info.ino}:${info.mtimeMs}:${info.size}` : 'absent'
      if (seen !== undefined && identity !== seen && identity !== 'absent') {
        clearTimeout(debounce)
        debounce = setTimeout(() => { debounce = undefined; input.onChange() }, input.debounceMs ?? 100)
        debounce.unref()
      }
      seen = identity
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => { void check() }, input.intervalMs ?? 125)
  timer.unref()
  void check()
  return {
    stop: () => {
      clearInterval(timer)
      clearTimeout(debounce)
    },
  }
}
