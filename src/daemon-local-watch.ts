import { stat } from 'node:fs/promises'

/**
 * How the running daemon hears that its owner saved something on this
 * computer. Every local writer replaces its file atomically (write a sibling,
 * rename), so the file's identity changes with every save; the daemon looks at
 * each watched file's identity a few times a second — one `stat` each — and
 * acts when it moves, appears or disappears. File-system events are not
 * reliable on the volumes this runs from, which is why this polls.
 *
 * The first look only records where each file stands: the daemon reads them
 * all when it starts.
 */
export const watchLocalFiles = (input: {
  paths: readonly string[]
  onChange: (path: string) => void
  intervalMs?: number
}): { stop: () => void } => {
  const seen = new Map<string, string>()
  let checking = false
  const identity = async (path: string): Promise<string> => {
    const info = await stat(path).catch(() => undefined)
    return info ? `${info.ino}:${info.mtimeMs}:${info.size}` : 'absent'
  }
  const check = async (): Promise<void> => {
    if (checking) return
    checking = true
    try {
      for (const path of input.paths) {
        const now = await identity(path)
        const before = seen.get(path)
        seen.set(path, now)
        if (before !== undefined && before !== now) input.onChange(path)
      }
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => { void check() }, input.intervalMs ?? 250)
  timer.unref()
  void check()
  return { stop: () => clearInterval(timer) }
}
