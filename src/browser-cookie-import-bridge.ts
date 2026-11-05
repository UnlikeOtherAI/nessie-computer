import { createHash } from 'node:crypto'

import { canonicalExecutorJson } from '@nessie/executor-protocol'

const MAX_SEALED_PAYLOAD_BYTES = 192 * 1024
export type BrowserCookieImportOffer = {
  destination: { agentName: string; retention: string; userName: string }
  expiresAt: string
  origins: string[]
  requestId: string
}

type BrowserCookieImportTransport = {
  pending: () => Promise<BrowserCookieImportOffer | null>
  upload: (input: {
    cookies: unknown
    payloadDigest: string
    requestId: string
    selectedOrigins: string[]
  }) => Promise<void>
}

type BrowserCookieImportFrame = { type?: unknown; [key: string]: unknown }

const validOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && (value === url.origin || value === `${url.origin}/`)
  } catch {
    return false
  }
}

const validText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= maximum

const validCookiePayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    return Buffer.byteLength(canonicalExecutorJson(value), 'utf8') <= MAX_SEALED_PAYLOAD_BYTES
  } catch {
    return false
  }
}

const validOffer = (offer: BrowserCookieImportOffer): boolean => (
  validText(offer.requestId, 128)
  && validText(offer.expiresAt, 128)
  && validText(offer.destination.agentName, 256)
  && validText(offer.destination.userName, 256)
  && validText(offer.destination.retention, 512)
  && offer.origins.length > 0
  && offer.origins.length <= 20
  && offer.origins.every(validOrigin)
)

const publicOffer = (offer: BrowserCookieImportOffer): Record<string, unknown> => ({
  destination: offer.destination,
  expiresAt: offer.expiresAt,
  origins: offer.origins,
  requestId: offer.requestId,
  type: 'browser_cookie_import.offer.v1',
})

const failure = (code: string): Record<string, unknown> => ({
  code,
  type: 'browser_cookie_import.result.v1',
})

const selectedOrigins = (value: unknown, offer: BrowserCookieImportOffer): string[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > offer.origins.length) return null
  if (!value.every(validOrigin)) return null
  const selected = [...new Set(value)]
  if (selected.length !== value.length || selected.some((origin) => !offer.origins.includes(origin))) return null
  return selected
}

/**
 * The native host is the capability holder. The extension only receives the
 * public consent offer and can submit one bounded cookie payload; neither path
 * emits cookie values or counts in a result frame.
 */
export const createBrowserCookieImportBridge = (transport: BrowserCookieImportTransport) => {
  let active: BrowserCookieImportOffer | null = null

  const handle = async (raw: unknown): Promise<Record<string, unknown>> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('BROWSER_COOKIE_IMPORT_FRAME_INVALID')
    const frame = raw as BrowserCookieImportFrame
    if (frame.type === 'browser_cookie_import.hello.v1') {
      if (active) return publicOffer(active)
      const offer = await transport.pending().catch(() => null)
      if (!offer || !validOffer(offer) || new Date(offer.expiresAt) <= new Date()) {
        return failure('BROWSER_COOKIE_IMPORT_UNAVAILABLE')
      }
      active = offer
      return publicOffer(offer)
    }
    if (frame.type !== 'browser_cookie_import.submit.v1' || !active) {
      return failure('BROWSER_COOKIE_IMPORT_UNAVAILABLE')
    }
    const current = active
    active = null
    const selected = frame.requestId === current.requestId ? selectedOrigins(frame.selectedOrigins, current) : null
    if (!selected || !validCookiePayload(frame.cookies)) {
      return failure('BROWSER_COOKIE_IMPORT_REJECTED')
    }
    const payloadDigest = `sha256:${createHash('sha256').update(canonicalExecutorJson(frame.cookies)).digest('hex')}`
    try {
      await transport.upload({
        cookies: frame.cookies,
        payloadDigest,
        requestId: current.requestId,
        selectedOrigins: selected,
      })
      return { requestId: current.requestId, type: 'browser_cookie_import.accepted.v1' }
    } catch {
      return failure('BROWSER_COOKIE_IMPORT_UPLOAD_FAILED')
    }
  }

  return { handle }
}
