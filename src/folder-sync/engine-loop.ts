import { unwatchFile, watchFile } from 'node:fs'

import { FOLDER_SYNC_TIMING, type FolderSyncHeartbeatSummary } from '@nessie/executor-protocol'

import type { FolderSyncEngine, PassOptions } from './engine.js'
import { STOP_CODES } from './engine-failures.js'
import { isTransientSyncError, syncErrorCode } from './transport.js'
import { watchTeamFolder, type ChangeHint, type FolderSyncWatcher } from './watcher.js'

/**
 * When passes run (plan §2.7). One pass at a time, never overlapping. After a
 * pass that changed something, another runs at once. Between passes the loop
 * waits for whichever comes first: a watcher hint (scan that subtree), news
 * from the journal long-poll (plan without walking), a file settling (look
 * again in two seconds), the ten-minute full reconcile (every sixth with a
 * snapshot), or stop. Failures back off from 1 s to 5 min.
 */

export type FolderSyncLoop = {
  summary(): FolderSyncHeartbeatSummary | undefined
  stop(): Promise<void>
}

type Wake = { scope: string[] | null; snapshot: boolean }

const CONFIG_POLL_MS = 2_000
const AWAITING_PERSON_MS = 30_000

export const startFolderSyncLoop = (
  engine: FolderSyncEngine,
  options: { watch?: boolean; onError?: (error: unknown) => void } = {},
): FolderSyncLoop => {
  let running = true
  let hinted: Set<string> | null | undefined
  let wakeUp: (() => void) | null = null
  let longPoll: AbortController | null = null
  let watcher: FolderSyncWatcher | null = null
  let watched: string | null = null
  let lastFull = 0
  let reconciles = 0

  const wake = () => {
    wakeUp?.()
    longPoll?.abort()
  }
  const hint = (change: ChangeHint) => {
    if (change.error) {
      watcher?.close()
      watcher = null
      watched = null
    }
    hinted = change.scope === null || hinted === null ? null : new Set([...(hinted ?? []), ...change.scope])
    wake()
  }
  const takeHint = (): string[] | null | undefined => {
    const taken = hinted
    hinted = undefined
    return taken === undefined ? undefined : taken === null ? null : [...taken]
  }
  const armWatcher = () => {
    if (options.watch === false) return
    const dir = engine.teamDir()
    if (dir === watched) return
    watcher?.close()
    watched = dir
    watcher = dir ? watchTeamFolder(dir, hint) : null
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakeUp = null; resolve() }, ms)
    wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve() }
  })

  /** Wait between passes; answers what the next pass should look at. */
  const idle = async (retryInMs: number | null, retryScope: string[] | null): Promise<Wake> => {
    const started = Date.now()
    const fullIn = Math.max(0, lastFull + FOLDER_SYNC_TIMING.fullReconcileMs - started)
    const until = Math.min(fullIn, retryInMs ?? Number.POSITIVE_INFINITY)
    while (running && hinted === undefined) {
      const left = until - (Date.now() - started)
      if (left <= 0) return { scope: until < fullIn ? retryScope : null, snapshot: false }
      longPoll = new AbortController()
      const polled = engine.waitForNews(longPoll.signal).catch((error: unknown) => {
        // Re-enter the pass now so its admission refusal settles local state.
        const code = syncErrorCode(error)
        if (code && STOP_CODES.has(code)) return { news: true, snapshot: false }
        if (!isTransientSyncError(error)) options.onError?.(error)
        return null
      })
      const pollStarted = Date.now()
      const answer = await Promise.race([polled, sleep(left).then(() => 'timer' as const)])
      longPoll.abort()
      longPoll = null
      wakeUp?.()
      // The poll folds into the index: it must be over before a pass starts.
      await polled
      if (answer === 'timer') continue
      if (answer?.news || answer?.snapshot) return { scope: [], snapshot: answer.snapshot }
      // A server that answered at once (or not at all) is asked again only after the pull interval.
      const waited = Date.now() - pollStarted
      const { pullIntervalMs } = FOLDER_SYNC_TIMING
      if (waited < pullIntervalMs) await sleep(Math.min(left, pullIntervalMs - waited))
    }
    const scope = takeHint()
    return { scope: scope === undefined ? null : scope, snapshot: false }
  }

  const loop = async () => {
    let backoff: number = FOLDER_SYNC_TIMING.backoffInitialMs
    let next: PassOptions = { scope: null }
    while (running) {
      if (Date.now() - lastFull >= FOLDER_SYNC_TIMING.fullReconcileMs) {
        lastFull = Date.now()
        reconciles += 1
        const sixth = reconciles % FOLDER_SYNC_TIMING.snapshotEveryReconciles === 0
        next = { scope: null, snapshot: next.snapshot === true || sixth }
      }
      try {
        const result = await engine.runPass(next)
        backoff = FOLDER_SYNC_TIMING.backoffInitialMs
        armWatcher()
        if (result.idle) {
          await sleep(FOLDER_SYNC_TIMING.pullIntervalMs)
          next = { scope: null }
        } else if (result.more) {
          next = { scope: null }
        } else {
          // A person's choice in Nessie arrives with a report: ask again soon while one may be waiting.
          const retryInMs = result.awaitingPerson
            ? Math.min(result.retryInMs ?? AWAITING_PERSON_MS, AWAITING_PERSON_MS)
            : result.retryInMs
          next = await idle(retryInMs, result.retryInMs === null && result.awaitingPerson ? [] : result.retryScope)
        }
      } catch (error) {
        if (!isTransientSyncError(error)) options.onError?.(error)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, FOLDER_SYNC_TIMING.backoffMaxMs)
        next = { scope: null }
      }
    }
  }

  // The console and the CLI change `config.json` while the daemon runs (on,
  // off, pause, another folder): a change wakes the loop, and the next pass
  // reads it — no daemon restart.
  const configChanged = () => hint({ scope: null })
  watchFile(engine.paths.config, { interval: CONFIG_POLL_MS, persistent: false }, configChanged)
  const done = loop()
  return {
    summary: () => engine.summary(),
    stop: async () => {
      running = false
      unwatchFile(engine.paths.config, configChanged)
      watcher?.close()
      wake()
      await done
    },
  }
}
