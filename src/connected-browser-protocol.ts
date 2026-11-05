import { randomBytes, timingSafeEqual } from 'node:crypto'

import type { ExecutorBrowserActArguments } from '@nessie/executor-protocol'

const MAX_NODES = 200
const MAX_TEXT_BYTES = 256
const MAX_URL_BYTES = 4_096

export type ConnectedBrowserNode = {
  name: string
  nodeId: number
  role: string
  value?: string
}

export type ConnectedBrowserObservation = {
  accessibilityTree: ConnectedBrowserNode[]
  url: string
}

export type ConnectedBrowserTransport = {
  act: (input: {
    action: ExecutorBrowserActArguments
    capability: string
    tabId: string
  }) => Promise<{ settledUrl?: string }>
  observe: (input: { capability: string; tabId: string }) => Promise<ConnectedBrowserObservation>
  open: (input: { capability: string; runId: string; url: string }) => Promise<{ tabId: string }>
  stop: (input: { capability: string; tabId: string }) => Promise<void>
}

type ExtensionFrame = {
  capability: string
  sequence: number
  type: 'connected_browser.observation' | 'connected_browser.stopped'
  observation?: ConnectedBrowserObservation
}

const isUrlWithinOrigins = (raw: string, origins: ReadonlySet<string>): boolean => {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && origins.has(url.origin)
      && raw.length <= MAX_URL_BYTES
  } catch {
    return false
  }
}

const stringWithin = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum

const safeNode = (value: unknown): ConnectedBrowserNode | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    !Number.isInteger(record.nodeId)
    || (record.nodeId as number) < 0
    || (record.nodeId as number) > 2_147_483_647
    || !stringWithin(record.name, MAX_TEXT_BYTES)
    || !stringWithin(record.role, MAX_TEXT_BYTES)
  ) return null
  // The extension classifies these by Chrome's structural control type, not
  // content heuristics. Their values and node ids never enter agent context.
  if (record.sensitive === true) return null
  return {
    name: record.name,
    nodeId: record.nodeId as number,
    role: record.role,
    ...(stringWithin(record.value, MAX_TEXT_BYTES) ? { value: record.value } : {}),
  }
}

/**
 * Narrow, replay-fenced parser for the native-messaging bridge. The extension
 * never forwards DevTools messages: only observations and terminal state are
 * admissible. A malformed, stale, or cross-session frame closes the caller's
 * session instead of yielding partial browser state.
 */
export const createConnectedBrowserFrameGate = (input: {
  allowedOrigins: ReadonlySet<string>
  capability: string
}) => {
  let lastSequence = 0
  let stopped = false

  const hasCapability = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    const left = Buffer.from(value)
    const right = Buffer.from(input.capability)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  const parse = (raw: unknown): ExtensionFrame | null => {
    if (stopped || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (
      !hasCapability(record.capability)
      || !Number.isInteger(record.sequence)
      || (record.sequence as number) <= lastSequence
    ) {
      return null
    }
    if (record.type === 'connected_browser.stopped') {
      lastSequence = record.sequence as number
      stopped = true
      return { capability: input.capability, sequence: lastSequence, type: record.type }
    }
    if (record.type !== 'connected_browser.observation' || !record.observation || typeof record.observation !== 'object') return null
    const observation = record.observation as Record<string, unknown>
    if (
      !isUrlWithinOrigins(observation.url as string, input.allowedOrigins)
      || !Array.isArray(observation.accessibilityTree)
    ) return null
    const nodes = observation.accessibilityTree
      .slice(0, MAX_NODES)
      .map(safeNode)
      .filter((node): node is ConnectedBrowserNode => node !== null)
    lastSequence = record.sequence as number
    return {
      capability: input.capability,
      observation: { accessibilityTree: nodes, url: observation.url as string },
      sequence: lastSequence,
      type: record.type,
    }
  }

  return { parse, stopped: () => stopped }
}

export const createConnectedBrowserCapability = (): string => randomBytes(32).toString('base64url')

export const connectedBrowserUrlAllowed = (raw: string, origins: ReadonlySet<string>): boolean =>
  isUrlWithinOrigins(raw, origins)
