import { codingHostSpawnFailed, codingHostSpawnPending } from './host-spawn.js'
import {
  encodeEventCursor,
  parseEventCursor,
  readEventPage,
  type EventCursor,
} from './session-events.js'
import { readJson, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import { hostLockIsStale, readHostLock } from './session-lock.js'
import { listRequests } from './session-requests.js'
import type { CodingSessionEvent, CodingSessionMeta, CodingSessionState, CodingSessionStatus } from './types.js'

/**
 * What `session_status` answers: non-blocking, at most 8 KB, with `status`,
 * `nextCursor` and `pendingNotice` serialised first so a truncation downstream
 * still keeps them.
 *
 * The bridge remembers how far it has delivered each session's events (a
 * session has exactly one owner, so that is the per-owner cursor), which lets
 * the model poll without carrying a cursor of its own. Status is derived at
 * read time: a session still marked working whose host has stopped
 * heartbeating is reported `interrupted` with reason `host_lost`, and one whose
 * requests no host could be started for reads `host_failed_to_start` —
 * `failed` before its first turn, `interrupted` (and resumable) after.
 */
export const CODING_STATUS_MAX_BYTES = 8 * 1024

const SUMMARY_READ_BYTES = 256 * 1024
const EVENTS_READ_BYTES = 7 * 1024

export type DerivedCodingStatus = {
  status: CodingSessionStatus
  reason?: string
  hostLive: boolean
  hostStarting: boolean
  inboxPending: number
}

export const deriveCodingStatus = async (
  paths: CodingSessionPaths, state: CodingSessionState | undefined,
): Promise<DerivedCodingStatus> => {
  const lock = await readHostLock(paths.lock)
  const hostLive = lock !== undefined && !hostLockIsStale(lock)
  const hostStarting = !hostLive && await codingHostSpawnPending(paths)
  const inboxPending = (await listRequests(paths)).length
  const base = { hostLive, hostStarting, inboxPending }
  if (state?.status !== 'closed' && state?.status !== 'failed' && inboxPending > 0 && !hostLive && !hostStarting
    && await codingHostSpawnFailed(paths)) {
    return { ...base, status: !state || state.turn === 0 ? 'failed' : 'interrupted', reason: 'host_failed_to_start' }
  }
  if (!state) {
    // No host has written anything yet. With nothing asked for and nothing starting, it never will.
    if (!hostLive && !hostStarting && inboxPending === 0) return { ...base, status: 'interrupted', reason: 'host_lost' }
    return { ...base, status: 'starting' }
  }
  if ((state.status === 'working' || state.status === 'starting') && !hostLive && !hostStarting) {
    return { ...base, status: 'interrupted', reason: 'host_lost' }
  }
  return { ...base, status: state.status, ...(state.reason ? { reason: state.reason } : {}) }
}

export const readDeliveredCursor = async (paths: CodingSessionPaths): Promise<EventCursor | undefined> => (
  parseEventCursor((await readJson<{ cursor?: unknown }>(paths.delivered))?.cursor)
)

const pendingNotice = (
  derived: DerivedCodingStatus, state: CodingSessionState | undefined, rotated: boolean, skipped: boolean,
): string => {
  const notes: string[] = []
  if (derived.reason === 'host_lost') {
    notes.push(derived.inboxPending > 0
      ? 'The session host stopped; a new one is starting to deliver your request.'
      : 'The session host stopped. Send a message to resume the session.')
  } else if (derived.reason === 'host_failed_to_start') {
    notes.push('No session host could start to deliver the request (see its host log); a new message tries again.')
  } else if (derived.hostStarting) {
    notes.push('The session host is starting.')
  }
  if (derived.inboxPending > 0 && derived.hostLive) notes.push(`${derived.inboxPending} request(s) not yet picked up.`)
  if (state?.queued) notes.push(`${state.queued} message(s) queued for the next turn.`)
  if (state?.backgroundTasks) {
    notes.push(`${state.backgroundTasks} background task(s) the coding agent started are still running; one finishing starts a new turn.`)
  }
  const denied = state?.lastResult?.permissionDenials.length ?? 0
  if (denied > 0 && (derived.status === 'waiting_for_input' || derived.status === 'interrupted')) {
    notes.push(`The coding agent was denied ${denied} action(s) that need approval; see permissionDenials.`)
  }
  if (rotated) notes.push('Older events were rotated away.')
  if (skipped) notes.push('An event too large to report was skipped.')
  return notes.join(' ')
}

const turnEnded = (status: CodingSessionStatus): boolean => status !== 'working' && status !== 'starting'

const summarise = (events: readonly CodingSessionEvent[]): Record<string, unknown> => {
  const toolCounts: Record<string, number> = {}
  const filesTouched = new Set<string>()
  let lastAssistant: string | undefined
  // What the agent is doing now: its latest tool call, as projected.
  let lastTool: { name: string; summary: string } | undefined
  for (const event of events) {
    if (event.kind === 'tool') {
      toolCounts[event.name] = (toolCounts[event.name] ?? 0) + 1
      lastTool = { name: event.name, summary: event.summary }
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.name) && event.summary) filesTouched.add(event.summary)
      if (event.name === 'edit' && event.summary) for (const file of event.summary.split(', ')) filesTouched.add(file)
    }
    if (event.kind === 'assistant') lastAssistant = event.text
  }
  return {
    newEvents: events.length,
    toolCounts,
    filesTouched: [...filesTouched].slice(-10),
    ...(lastAssistant ? { lastAssistant: lastAssistant.slice(0, 600) } : {}),
    ...(lastTool ? { lastTool } : {}),
  }
}

export const composeCodingStatus = async (input: {
  paths: CodingSessionPaths
  meta: CodingSessionMeta
  state: CodingSessionState | undefined
  derived: DerivedCodingStatus
  detail: 'summary' | 'events'
  cursor?: EventCursor
}): Promise<Record<string, unknown>> => {
  const { paths, meta, state, derived } = input
  const generation = state?.eventsGeneration ?? 0
  const from = input.cursor ?? await readDeliveredCursor(paths)
  const page = await readEventPage(paths, generation, from, input.detail === 'events'
    ? { maxBytes: EVENTS_READ_BYTES, maxEvents: 200 }
    : { maxBytes: SUMMARY_READ_BYTES, maxEvents: 5_000 })
  const ended = turnEnded(derived.status)
  const start: EventCursor = from && !page.rotated ? from : { generation, offset: 0, seq: from?.seq ?? 0 }
  const cursorAfter = (keep: number): EventCursor => (
    keep === page.events.length ? page.next : keep === 0 ? start : page.positions[keep - 1]!
  )
  let lastResult = ended ? state?.lastResult : undefined
  let events = page.events
  const build = (keep: number): Record<string, unknown> => {
    const next = cursorAfter(keep)
    const notice = pendingNotice(derived, state, page.rotated, page.skipped)
    return {
      status: derived.status,
      nextCursor: encodeEventCursor(next),
      ...(notice ? { pendingNotice: notice } : {}),
      ...(derived.reason ? { reason: derived.reason } : {}),
      sessionId: meta.sessionId,
      agent: meta.agent,
      root: meta.rootName,
      path: meta.path,
      title: meta.title,
      turn: state?.turn ?? 0,
      updatedAt: state?.updatedAt ?? meta.createdAt,
      ...(state?.queued ? { queuedMessages: state.queued } : {}),
      ...(state?.backgroundTasks ? { backgroundTasks: state.backgroundTasks } : {}),
      // What the session has cost so far, across every turn: a ticket's work adds
      // only what is new since the last read to its spend.
      ...(state?.totalCostUsd === undefined ? {} : { totalCostUsd: state.totalCostUsd }),
      moreEvents: page.more || keep < events.length,
      ...(input.detail === 'events'
        ? { events: events.slice(0, keep) }
        : { summary: summarise(events.slice(0, keep)) }),
      ...(lastResult ? { lastResult } : {}),
      ...(state?.permissionDenials.length ? { permissionDenials: state.permissionDenials.slice(-5) } : {}),
    }
  }
  // The answer shrinks without ever stalling: events are halved down to one,
  // then a long final result is cut, and if the one event still does not fit
  // (each line is capped when it is written, so it should) its placeholder
  // goes out instead. Either way the cursor moves.
  const tooBig = (value: Record<string, unknown>): boolean => (
    Buffer.byteLength(JSON.stringify(value)) > CODING_STATUS_MAX_BYTES
  )
  let keep = events.length
  let answer = build(keep)
  while (tooBig(answer) && keep > 1) {
    keep = Math.floor(keep / 2)
    answer = build(keep)
  }
  if (tooBig(answer) && lastResult) {
    lastResult = {
      ...lastResult, text: lastResult.text.slice(0, 1_500), permissionDenials: lastResult.permissionDenials.slice(0, 5),
    }
    answer = build(keep)
  }
  if (tooBig(answer) && keep === 1) {
    const [only] = events
    events = [{ seq: only!.seq, at: only!.at, kind: 'system', subtype: 'oversized' }]
    answer = build(keep)
  }
  if (keep > 0 || page.rotated || page.skipped) {
    await writeJsonAtomic(paths.delivered, { cursor: encodeEventCursor(cursorAfter(keep)) }).catch(() => undefined)
  }
  return answer
}
