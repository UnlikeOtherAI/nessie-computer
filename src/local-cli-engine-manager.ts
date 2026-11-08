import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { runsUnderWindowsService } from './coding-session/self-check.js'
import type { LocalInferenceHostSession } from './local-inference-host-session.js'
import type { ExecutorLocalState } from './state-store.js'
import { readLocalCliAccounts, localCliAccountsRoot, type LocalCliAccount } from './local-cli-engine-accounts.js'
import { createLocalCliEngineBackend, type LocalCliSessionGate } from './local-cli-engine-backend.js'
import { detectLocalCliEngines } from './local-cli-engine-detect.js'
import { connectLocalCliHost, registerLocalCliHost, type LocalCliRegistration } from './local-cli-engine-host.js'
import {
  LOCAL_CLI_SETTINGS_FILE, localCliEngineKey, parseLocalCliEngineKey, readLocalCliAvailability, readLocalCliStatus,
  writeLocalCliStatus,
  type LocalCliEngineKey,
} from './local-cli-engine-settings.js'

/**
 * Keeps one `local_cli` host per engine connection the owner made available
 * for this team (contract §12), beside the team's local-weights host. A switch
 * turned on registers and connects its host; turned off, it withdraws it from
 * Nessie. Changes to the switches or the account list apply within a second
 * or two, without restarting the team.
 */
type Entry = {
  key: LocalCliEngineKey
  session?: LocalInferenceHostSession
  stopRuns?: (runIds: readonly string[]) => void
}

export type LocalCliEngineManager = {
  reconcile: (state?: ExecutorLocalState) => Promise<void>
  heartbeat: () => Promise<void>
  drain: () => Promise<void>
  resume: () => void
  isIdle: () => boolean
  stopRuns: (runIds: readonly string[]) => void
  setSessionGate: (gate: LocalCliSessionGate) => void
  stop: () => Promise<void>
}

const RETRY_UNSUPPORTED_MS = 60 * 60_000
const WATCH_MS = 1_500

export const createLocalCliEngineManager = (stateDir: string, initial: ExecutorLocalState, options: {
  accountsRoot?: string
  register?: typeof registerLocalCliHost
  connect?: typeof connectLocalCliHost
  log?: (message: string) => void
  watch?: boolean
  underService?: () => Promise<boolean>
} = {}): LocalCliEngineManager => {
  const accountsRoot = options.accountsRoot ?? localCliAccountsRoot()
  const register = options.register ?? registerLocalCliHost
  const connect = options.connect ?? connectLocalCliHost
  const log = options.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  let state = initial
  let draining = false
  let gate: LocalCliSessionGate | undefined
  const entries = new Map<string, Entry>()
  /** Keys this daemon registered as available, so turning one off withdraws exactly those. */
  const offered = new Map<string, 'yes' | 'not_yet'>()
  let unsupportedAt = 0
  let seeded = false
  let written = '[]'
  let fingerprint = ''
  let stopped = false

  const close = async (name: string): Promise<void> => {
    const entry = entries.get(name)
    entries.delete(name)
    entry?.session?.loop.stop()
    await entry?.session?.stop()
  }

  const open = async (key: LocalCliEngineKey, account: LocalCliAccount | undefined): Promise<'yes' | 'not_yet'> => {
    // A team the Windows service runs is under the service's account, which has no sign-in of the owner's.
    if (await (options.underService ?? (() => runsUnderWindowsService({ received: process.env })))()) return 'not_yet'
    const registration: LocalCliRegistration = await register(state, key.engine, key.profileId, true)
    if (registration.kind !== 'host') {
      if (registration.kind === 'unsupported') unsupportedAt = Date.now()
      return 'not_yet'
    }
    const backend = createLocalCliEngineBackend({ ...key, name: account?.name ?? null,
      detect: async () => (await detectLocalCliEngines({ accounts: [], accountsRoot, only: key }))[0]!,
    }, { sessions: { refused: (sessionId) => gate?.refused(sessionId) ?? false } })
    const session = await connect({ stateDir, state, engine: key.engine, profileId: key.profileId,
      host: registration, backend, isPaused: () => draining })
    const name = localCliEngineKey(key)
    entries.set(name, { key, session, stopRuns: backend.stopRuns })
    void session.refused.then(() => { if (entries.get(name)?.session === session) void close(name) })
    return 'yes'
  }

  const apply = async (): Promise<void> => {
    const accounts = await readLocalCliAccounts(accountsRoot).catch(() => [])
    const wanted = new Map<string, LocalCliEngineKey>()
    for (const name of await readLocalCliAvailability(stateDir).catch(() => new Set<string>())) {
      const key = parseLocalCliEngineKey(name)
      const known = key.profileId === null
        || accounts.some((account) => account.id === key.profileId && account.engine === key.engine)
      if (known) {
        wanted.set(name, key)
      }
    }
    for (const name of [...offered.keys()]) {
      if (wanted.has(name)) continue
      await close(name)
      const key = parseLocalCliEngineKey(name)
      await register(state, key.engine, key.profileId, false).catch((error: unknown) => {
        log(`${name} was not withdrawn: ${error instanceof Error ? error.message : String(error)}`)
      })
      offered.delete(name)
    }
    for (const [name, key] of wanted) {
      if (entries.has(name)) continue
      if (offered.get(name) === 'not_yet' && Date.now() - unsupportedAt < RETRY_UNSUPPORTED_MS) continue
      try {
        offered.set(name, await open(key, accounts.find((account) => account.id === key.profileId)))
      } catch (error) {
        offered.set(name, 'not_yet')
        log(`${name} was not offered: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const report = JSON.stringify([...offered].sort())
    if (report !== written) {
      written = report
      await writeLocalCliStatus(stateDir, Object.fromEntries(offered)).catch(() => undefined)
    }
  }

  /** One reconciliation at a time, in order; each sees the switches as they are when it starts. */
  let chain: Promise<void> = Promise.resolve()
  const reconcile = (next?: ExecutorLocalState): Promise<void> => {
    const run = chain.then(async () => {
      if (stopped) return
      if (!seeded) {
        seeded = true
        // Hosts offered before this daemon started can be withdrawn while it was not running.
        const saved = await readLocalCliStatus(stateDir).catch(() => null)
        for (const [name, value] of Object.entries(saved?.offered ?? {})) if (value === 'yes') offered.set(name, 'yes')
      }
      if (next && next.connectionEpoch !== state.connectionEpoch) {
        // A new executor claim fences every host of the old epoch; they claim afresh.
        state = next
        unsupportedAt = 0
        for (const name of [...entries.keys()]) await close(name)
        for (const [name, value] of offered) if (value === 'not_yet') offered.delete(name)
      } else if (next) state = next
      await apply()
    })
    chain = run.catch(() => undefined)
    return run
  }

  const files = [join(stateDir, LOCAL_CLI_SETTINGS_FILE), join(accountsRoot, 'accounts.json')]
  const watcher = options.watch === false ? undefined : setInterval(() => {
    void Promise.all(files.map((path) => stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => '-')))
      .then((marks) => {
        const next = marks.join('|')
        if (next === fingerprint) return
        fingerprint = next
        void reconcile().catch(() => undefined)
      })
  }, WATCH_MS)
  watcher?.unref()

  return {
    reconcile,
    heartbeat: async () => {
      if (Date.now() - unsupportedAt >= RETRY_UNSUPPORTED_MS && [...offered.values()].includes('not_yet')) {
        await reconcile().catch(() => undefined)
      }
      await Promise.all([...entries.values()].map((entry) => entry.session?.heartbeat().catch(() => undefined)))
    },
    drain: async () => {
      draining = true
      await Promise.all([...entries.values()].map((entry) => entry.session?.loop.drain()))
    },
    resume: () => {
      draining = false
      for (const entry of entries.values()) entry.session?.loop.resume()
    },
    isIdle: () => [...entries.values()].every((entry) => entry.session?.loop.isIdle() ?? true),
    stopRuns: (runIds) => { for (const entry of entries.values()) entry.stopRuns?.(runIds) },
    setSessionGate: (next) => { gate = next },
    stop: async () => {
      stopped = true
      if (watcher) clearInterval(watcher)
      await chain
      for (const name of [...entries.keys()]) await close(name)
    },
  }
}
