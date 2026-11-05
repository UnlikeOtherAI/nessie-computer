import { createRequire, syncBuiltinESMExports } from 'node:module'

/**
 * Crash injection at the filesystem: `fs/promises.rename` is the step every
 * install, local move and state-file replace ends with, so a simulated crash
 * there lands between a journal record and its effect (`before`) or between
 * the effect and the bookkeeping after it (`after`). The hook is installed
 * once per process and only fires for a path under an armed prefix; the
 * simulator's own file operations run with `bypass` set.
 */

type Arm = { mode: 'before' | 'after'; countdown: number; onFire: () => void }

const arms = new Map<string, Arm>()
let installed = false
let bypassDepth = 0

/** The error a crash throws: a `TypeError`, which the engine treats like a dropped connection and stops its pass on. */
export class SimulatedCrash extends TypeError {
  constructor(where: string) {
    super(`simulated crash at ${where}`)
  }
}

const armFor = (path: string): [string, Arm] | null => {
  for (const [prefix, arm] of arms) if (path.toLowerCase().includes(prefix)) return [prefix, arm]
  return null
}

const install = (): void => {
  if (installed) return
  installed = true
  const require = createRequire(import.meta.url)
  const fsp = require('node:fs/promises') as typeof import('node:fs/promises')
  const original = fsp.rename
  const hooked: typeof original = async (from, to) => {
    const found = bypassDepth === 0 ? armFor(String(to)) ?? armFor(String(from)) : null
    if (found) {
      const [prefix, arm] = found
      arm.countdown -= 1
      if (arm.countdown <= 0) {
        arms.delete(prefix)
        arm.onFire()
        if (arm.mode === 'before') throw new SimulatedCrash(`rename to ${String(to)}`)
        await original(from, to)
        throw new SimulatedCrash(`after rename to ${String(to)}`)
      }
    }
    return original(from, to)
  }
  fsp.rename = hooked
  syncBuiltinESMExports()
}

/** Crash the `countdown`-th rename under `prefix` (an absolute directory). */
export const armRenameCrash = (prefix: string, mode: Arm['mode'], countdown: number, onFire: () => void): void => {
  install()
  arms.set(prefix.toLowerCase(), { mode, countdown, onFire })
}

export const disarmRenameCrash = (prefix: string): void => {
  arms.delete(prefix.toLowerCase())
}

/** Run the simulator's own file operations (a person editing) without tripping a crash. */
export const bypassHooks = async <T>(work: () => Promise<T>): Promise<T> => {
  bypassDepth += 1
  try {
    return await work()
  } finally {
    bypassDepth -= 1
  }
}
