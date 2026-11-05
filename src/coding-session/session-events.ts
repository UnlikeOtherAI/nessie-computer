import { open, stat, type FileHandle } from 'node:fs/promises'

import { renameWithRetry, type CodingSessionPaths } from './session-files.js'
import type { CodingEventBody, CodingSessionEvent } from './types.js'

/**
 * `events.jsonl`: projected events, appended by the host alone, read by the
 * bridge through a cursor of `generation.byteOffset.seq`.
 *
 * A reader consumes only newline-terminated lines, so a line the host is half
 * way through writing is never parsed and never skipped — the next read picks
 * it up whole. Rotation at 16 MiB moves the file aside once and bumps the
 * generation; a cursor from an older generation restarts at the top of the
 * new file and says so.
 *
 * Every line is at most `EVENT_LINE_MAX_BYTES`, so one event always fits the
 * reader's window and an 8 KB status answer: a longer one is shortened, field
 * by field, before it is written. A line longer than a reader's window that
 * got here anyway is skipped whole rather than read forever.
 */
export const EVENTS_ROTATE_BYTES = 16 * 1024 * 1024
export const EVENT_LINE_MAX_BYTES = 4 * 1024

export type EventCursor = { generation: number; offset: number; seq: number }

export const encodeEventCursor = (cursor: EventCursor): string => `${cursor.generation}.${cursor.offset}.${cursor.seq}`

export const parseEventCursor = (value: unknown): EventCursor | undefined => {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,6})\.(\d{1,12})\.(\d{1,12})$/u.exec(value)
  if (!match) return undefined
  return { generation: Number(match[1]), offset: Number(match[2]), seq: Number(match[3]) }
}

export type EventLog = {
  append: (body: CodingEventBody) => Promise<CodingSessionEvent>
  close: () => Promise<void>
}

const bytesOf = (value: unknown): number => Buffer.byteLength(`${JSON.stringify(value)}\n`)

/**
 * The event as one line of at most `maxBytes`: its longest string (or list)
 * is halved until it fits — JSON escaping and multibyte text can make 4 000
 * characters far more than 4 000 bytes — and anything that still does not fit
 * becomes a bare `system/oversized` event with the same `seq`.
 */
export const fitEventLine = (event: CodingSessionEvent, maxBytes = EVENT_LINE_MAX_BYTES): string => {
  if (bytesOf(event) <= maxBytes) return `${JSON.stringify(event)}\n`
  const shrunk: Record<string, unknown> = { ...event }
  for (let pass = 0; pass < 24 && bytesOf(shrunk) > maxBytes; pass += 1) {
    const [key, value] = Object.entries(shrunk)
      .filter(([name, entry]) => name !== 'kind' && name !== 'subtype' && (typeof entry === 'string' || Array.isArray(entry)))
      .sort(([, left], [, right]) => bytesOf(right) - bytesOf(left))[0] ?? []
    if (key === undefined) break
    shrunk[key] = typeof value === 'string'
      ? `${value.slice(0, Math.floor(value.length / 2))}…`
      : (value as unknown[]).slice(0, Math.floor((value as unknown[]).length / 2))
  }
  const fitted = bytesOf(shrunk) <= maxBytes ? shrunk : { seq: event.seq, at: event.at, kind: 'system', subtype: 'oversized' }
  return `${JSON.stringify(fitted)}\n`
}

export const openEventLog = async (
  paths: CodingSessionPaths,
  position: { generation: number; lastSeq: number },
  onAppend: (position: { generation: number; lastSeq: number; rotated: boolean }) => void,
  rotateBytes = EVENTS_ROTATE_BYTES,
): Promise<EventLog> => {
  let generation = position.generation
  let seq = position.lastSeq
  let handle: FileHandle = await open(paths.events, 'a', 0o600)
  let size = (await handle.stat()).size
  let queue: Promise<unknown> = Promise.resolve()
  let rotateAgainAt = 0
  /**
   * Moves the file aside. When Windows will not let go of it, appends carry on
   * in the same file and the next rotation is tried half a minute later.
   */
  const rotate = async (): Promise<boolean> => {
    if (Date.now() < rotateAgainAt) return false
    await handle.close()
    try {
      await renameWithRetry(paths.events, paths.previousEvents)
    } catch {
      handle = await open(paths.events, 'a', 0o600)
      rotateAgainAt = Date.now() + 30_000
      return false
    }
    generation += 1
    handle = await open(paths.events, 'a', 0o600)
    size = 0
    return true
  }
  const appendOne = async (body: CodingEventBody): Promise<CodingSessionEvent> => {
    seq += 1
    const event = { seq, at: new Date().toISOString(), ...body } as CodingSessionEvent
    const line = fitEventLine(event)
    const bytes = Buffer.byteLength(line)
    const rotated = size > 0 && size + bytes > rotateBytes && await rotate()
    await handle.write(line)
    size += bytes
    onAppend({ generation, lastSeq: seq, rotated })
    return event
  }
  return {
    append: (body) => {
      const next = queue.then(() => appendOne(body))
      queue = next.catch(() => undefined)
      return next
    },
    close: async () => {
      await queue
      await handle.close()
    },
  }
}

export type EventPage = {
  events: CodingSessionEvent[]
  /** The cursor just past each event, so a caller that keeps fewer can still resume exactly. */
  positions: EventCursor[]
  next: EventCursor
  /** Events between the cursor and the top of the current file were rotated away. */
  rotated: boolean
  /** A line longer than the window was skipped whole. */
  skipped: boolean
  /** More complete lines remain after `next`. */
  more: boolean
}

const SKIP_SCAN_BYTES = 64 * 1024

/** The offset just past the next newline at or after `from`, or undefined when the line is not whole yet. */
const endOfLine = async (handle: FileHandle, from: number, size: number): Promise<number | undefined> => {
  const chunk = Buffer.alloc(SKIP_SCAN_BYTES)
  for (let offset = from; offset < size; offset += SKIP_SCAN_BYTES) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(SKIP_SCAN_BYTES, size - offset), offset)
    const newline = chunk.subarray(0, bytesRead).indexOf(0x0a)
    if (newline >= 0) return offset + newline + 1
    if (bytesRead === 0) break
  }
  return undefined
}

export const readEventPage = async (
  paths: CodingSessionPaths,
  generation: number,
  cursor: EventCursor | undefined,
  limits: { maxBytes: number; maxEvents: number },
): Promise<EventPage> => {
  const rotated = cursor !== undefined && cursor.generation !== generation
  let start = cursor && !rotated ? cursor.offset : 0
  const size = await stat(paths.events).then((info) => info.size, () => 0)
  if (start > size) start = 0
  const seqBefore = cursor?.seq ?? 0
  const empty: EventPage = {
    events: [], positions: [], next: { generation, offset: start, seq: seqBefore },
    rotated, skipped: false, more: false,
  }
  if (start === size) return empty
  const length = Math.min(limits.maxBytes, size - start)
  const buffer = Buffer.alloc(length)
  const handle = await open(paths.events, 'r').catch(() => undefined)
  if (!handle) return empty
  try {
    await handle.read(buffer, 0, length, start)
    if (buffer.indexOf(0x0a) < 0 && start + length < size) {
      // One line longer than the whole window: without this the cursor would never move again.
      const past = await endOfLine(handle, start + length, size)
      if (past === undefined) return empty
      return { ...empty, next: { generation, offset: past, seq: seqBefore }, skipped: true, more: past < size }
    }
  } finally {
    await handle.close()
  }
  const events: CodingSessionEvent[] = []
  const positions: EventCursor[] = []
  let consumed = 0
  let seq = seqBefore
  while (events.length < limits.maxEvents) {
    const newline = buffer.indexOf(0x0a, consumed)
    if (newline < 0) break
    const text = buffer.subarray(consumed, newline).toString('utf8')
    consumed = newline + 1
    try {
      const event = JSON.parse(text) as CodingSessionEvent
      events.push(event)
      seq = event.seq
      positions.push({ generation, offset: start + consumed, seq })
    } catch {
      // A line that is not JSON cannot have come from the host; skip it.
    }
  }
  const offset = start + consumed
  return { events, positions, next: { generation, offset, seq }, rotated, skipped: false, more: offset < size }
}
