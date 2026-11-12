import type { ExecutorCommandCapacityKind } from '@nessie/executor-protocol'

import type { CommandLimits } from './command-resources.js'

/**
 * Where held commands wait to start. A command starts when its kind has a
 * free slot on the computer and in its session, the computer's overall limit
 * allows it, and none of its resources is held — or wanted by a command that
 * arrived earlier and is still waiting, so commands sharing a resource start
 * in arrival order. Commands that share nothing pass a blocked one.
 */
export type CommandTicket = {
  kind: ExecutorCommandCapacityKind | null
  session: string | null
  resources: readonly string[]
  /** Ends the wait without a slot; `acquire` then answers `null`. */
  signal?: AbortSignal
}

export type CommandQueue = {
  /** Resolves with the slot's release once it may start, or `null` when the wait was aborted. */
  acquire: (ticket: CommandTicket) => Promise<(() => void) | null>
  /** Commands of a kind now running. */
  running: (kind: ExecutorCommandCapacityKind) => number
  /** Commands now waiting. */
  waiting: () => number
  /** Starts nothing of `kind` until the returned function is called; running ones finish. */
  holdKind: (kind: ExecutorCommandCapacityKind) => () => void
  /** Re-reads the limits and starts whatever now may. */
  pump: () => void
}

type Waiter = CommandTicket & { start: (release: (() => void) | null) => void }

export const createCommandQueue = (limits: {
  computer: () => CommandLimits
  session: CommandLimits
  /** How many commands of any kind may run at once: one when Nessie hands out one at a time. */
  total: () => number
}): CommandQueue => {
  const waiters: Waiter[] = []
  const heldResources = new Set<string>()
  const runningByKind = new Map<ExecutorCommandCapacityKind, number>()
  const runningBySession = new Map<string, number>()
  const heldKinds = new Map<ExecutorCommandCapacityKind, number>()
  let runningTotal = 0

  const sessionKey = (ticket: CommandTicket): string => `${ticket.session ?? ''}\u0000${ticket.kind ?? ''}`

  const fits = (ticket: CommandTicket): boolean => {
    if (ticket.resources.some((resource) => heldResources.has(resource))) return false
    if (ticket.kind === null) return true
    if ((heldKinds.get(ticket.kind) ?? 0) > 0) return false
    if (runningTotal >= limits.total()) return false
    if ((runningByKind.get(ticket.kind) ?? 0) >= limits.computer()[ticket.kind]) return false
    return (runningBySession.get(sessionKey(ticket)) ?? 0) < limits.session[ticket.kind]
  }

  const occupy = (ticket: CommandTicket): (() => void) => {
    for (const resource of ticket.resources) heldResources.add(resource)
    if (ticket.kind !== null) {
      runningTotal += 1
      runningByKind.set(ticket.kind, (runningByKind.get(ticket.kind) ?? 0) + 1)
      runningBySession.set(sessionKey(ticket), (runningBySession.get(sessionKey(ticket)) ?? 0) + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const resource of ticket.resources) heldResources.delete(resource)
      if (ticket.kind !== null) {
        runningTotal -= 1
        runningByKind.set(ticket.kind, (runningByKind.get(ticket.kind) ?? 1) - 1)
        const key = sessionKey(ticket)
        const left = (runningBySession.get(key) ?? 1) - 1
        if (left > 0) runningBySession.set(key, left)
        else runningBySession.delete(key)
      }
      pump()
    }
  }

  function pump(): void {
    const wanted = new Set<string>()
    for (let index = 0; index < waiters.length;) {
      const waiter = waiters[index]!
      if (waiter.signal?.aborted) {
        waiters.splice(index, 1)
        waiter.start(null)
        continue
      }
      if (!waiter.resources.some((resource) => wanted.has(resource)) && fits(waiter)) {
        waiters.splice(index, 1)
        waiter.start(occupy(waiter))
        continue
      }
      for (const resource of waiter.resources) wanted.add(resource)
      index += 1
    }
  }

  return {
    acquire: (ticket) => new Promise((resolve) => {
      if (ticket.signal?.aborted) {
        resolve(null)
        return
      }
      const waiter: Waiter = { ...ticket, start: resolve }
      ticket.signal?.addEventListener('abort', () => pump(), { once: true })
      waiters.push(waiter)
      pump()
    }),
    running: (kind) => runningByKind.get(kind) ?? 0,
    waiting: () => waiters.length,
    holdKind: (kind) => {
      heldKinds.set(kind, (heldKinds.get(kind) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const left = (heldKinds.get(kind) ?? 1) - 1
        if (left > 0) heldKinds.set(kind, left)
        else heldKinds.delete(kind)
        pump()
      }
    },
    pump,
  }
}
