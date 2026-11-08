import { localCommandPolicyOf, type LocalCommandPolicy } from './command-policy.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * The daemon's one current copy of its team's local state.
 *
 * A saved change (`configure`, a program request's "always", a re-proposed
 * set of local apps) reaches the running daemon as a new copy here
 * (`daemon-live-apply.ts`), so the dispatch and every component built once at
 * start check work against the policy the owner saved last, without a
 * restart. Components hold `view`, which reads `current` on every access and
 * is read-only, rather than a snapshot taken when they were built.
 *
 * `allowOnce` changes the command rules for the length of one launch the
 * owner allowed: it adds the program's rule, or — for a terminal program named
 * by its path, which no rule can name — allows every program not denied. It is
 * sound because the daemon runs one command at a time: the loan exists only
 * while that command runs, and nothing else launches a program meanwhile. A
 * second loan while one is out is refused rather than shared.
 */
export type DaemonLiveState = {
  readonly current: ExecutorLocalState
  readonly view: ExecutorLocalState
  /** The command rules launches are checked against now, a loan included. */
  readonly commandRules: LocalCommandPolicy
  set: (next: ExecutorLocalState) => void
  allowOnce: <T>(loan: CommandRulesLoan, work: () => Promise<T>) => Promise<T>
}

/** What one allowed launch borrows: the saved rules in, the rules it runs under out. The denylist stays. */
export type CommandRulesLoan = (saved: LocalCommandPolicy) => LocalCommandPolicy

export const lendRule = (rule: string): CommandRulesLoan => (saved) => (
  saved.allowlist.includes(rule) ? saved : { ...saved, allowlist: [...saved.allowlist, rule].sort() }
)

export const lendAnyProgram: CommandRulesLoan = (saved) => ({ ...saved, mode: 'all' })

/**
 * A read-only object that answers every read from `read()` — keys, `in` and
 * spreading included — so a component that took it once sees what holds now.
 */
export const liveView = <T extends object>(read: () => T): T => new Proxy({} as T, {
  get: (_target, key) => Reflect.get(read(), key),
  has: (_target, key) => Reflect.has(read(), key),
  ownKeys: () => Reflect.ownKeys(read()),
  getOwnPropertyDescriptor: (_target, key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(read(), key)
    return descriptor && { ...descriptor, configurable: true, writable: false }
  },
  set: () => { throw new TypeError('The daemon state view is read-only.') },
  defineProperty: () => { throw new TypeError('The daemon state view is read-only.') },
  deleteProperty: () => { throw new TypeError('The daemon state view is read-only.') },
})

export const createDaemonLiveState = (initial: ExecutorLocalState): DaemonLiveState => {
  let current = initial
  let loaned: CommandRulesLoan | undefined
  const rules = (): LocalCommandPolicy => {
    const saved = localCommandPolicyOf(current)
    return loaned ? { ...loaned(saved), denylist: saved.denylist } : saved
  }
  const effective = (): ExecutorLocalState => (loaned === undefined ? current : { ...current, commandPolicy: rules() })
  const view = liveView(effective)
  return {
    get current() { return current },
    view,
    get commandRules() { return rules() },
    set: (next) => {
      if (next.executorId !== current.executorId) throw new Error('A daemon serves one team for its whole life.')
      current = next
    },
    allowOnce: async (loan, work) => {
      if (loaned !== undefined) throw new Error('Only one launch at a time can be allowed once.')
      loaned = loan
      try {
        return await work()
      } finally {
        loaned = undefined
      }
    },
  }
}
