import { createHash } from 'node:crypto'

import { canonicalExecutorJson } from '@nessie/executor-protocol'

export const DEFAULT_OLLAMA_LOOPBACK_ORIGINS = [
  'http://127.0.0.1:11434',
  'http://[::1]:11434',
] as const

const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/u
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/
const MAX_RESPONSES_PER_SWEEP = 3

export class LocalLoopbackOriginError extends Error {
  override readonly name = 'LocalLoopbackOriginError'
}

/**
 * Resolve nothing: accepted inputs are literal IPv4/IPv6 loopback origins
 * only.  A hostname would turn a host-local capability into a DNS decision.
 */
export const assertLoopbackOrigin = (origin: string): string => {
  if (!LOOPBACK_ORIGIN_PATTERN.test(origin)) {
    throw new LocalLoopbackOriginError('Ollama origin must be a literal loopback HTTP origin')
  }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new LocalLoopbackOriginError('Ollama origin must be a URL')
  }
  const host = url.hostname.toLowerCase()
  const ipv4 = host.startsWith('127.')
    && host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  if (!ipv4 && host !== '[::1]' && host !== '::1') {
    throw new LocalLoopbackOriginError('Ollama origin must be a loopback address')
  }
  return url.origin
}

/**
 * Saved first, then IPv4, then IPv6. The order is a protocol property rather
 * than a response-time race, and duplicate canonical spellings probe once.
 */
export const orderedOllamaLoopbackEndpoints = (savedOrigin?: string | null): string[] => {
  const candidates = [
    ...(savedOrigin === undefined || savedOrigin === null ? [] : [savedOrigin]),
    ...DEFAULT_OLLAMA_LOOPBACK_ORIGINS,
  ]
  const ordered: string[] = []
  for (const candidate of candidates) {
    const canonical = assertLoopbackOrigin(candidate)
    if (!ordered.includes(canonical)) ordered.push(canonical)
  }
  return ordered
}

export type OllamaLoopbackEndpointEvidence = {
  /** A locally derived fingerprint, not a raw version or host value. */
  daemonFingerprint: string
  /** Digest over the normalized observed manifest-digest set. */
  modelSetFingerprint: string
  origin: string
}

export type OllamaLoopbackEndpointResolution =
  | { kind: 'unavailable'; candidates: string[] }
  | { kind: 'selected'; canonicalSocket: string }
  | { kind: 'conflict'; candidates: string[] }

const evidenceFingerprint = (evidence: OllamaLoopbackEndpointEvidence): string => {
  if (!SHA256_DIGEST.test(evidence.daemonFingerprint)) {
    throw new LocalLoopbackOriginError('Ollama daemon fingerprint is invalid')
  }
  if (!SHA256_DIGEST.test(evidence.modelSetFingerprint)) {
    throw new LocalLoopbackOriginError('Ollama model-set fingerprint is invalid')
  }
  return `${evidence.daemonFingerprint}\n${evidence.modelSetFingerprint}`
}

/**
 * Pick only when all responding endpoints describe the same daemon/model set.
 * A caller therefore cannot turn network timing into authority over a socket.
 */
export const resolveOllamaLoopbackEndpoint = (input: {
  evidence: readonly OllamaLoopbackEndpointEvidence[]
  savedOrigin?: string | null
}): OllamaLoopbackEndpointResolution => {
  const candidates = orderedOllamaLoopbackEndpoints(input.savedOrigin)
  if (input.evidence.length > MAX_RESPONSES_PER_SWEEP) {
    throw new LocalLoopbackOriginError('Ollama discovery exceeded its endpoint bound')
  }
  const responses = new Map<string, string>()
  for (const reported of input.evidence) {
    const origin = assertLoopbackOrigin(reported.origin)
    if (!candidates.includes(origin)) {
      throw new LocalLoopbackOriginError('Ollama response was not from a probed endpoint')
    }
    const fingerprint = evidenceFingerprint(reported)
    const previous = responses.get(origin)
    if (previous !== undefined && previous !== fingerprint) {
      return { candidates: [origin], kind: 'conflict' }
    }
    responses.set(origin, fingerprint)
  }
  const respondingCandidates = candidates.filter((candidate) => responses.has(candidate))
  if (respondingCandidates.length === 0) return { candidates, kind: 'unavailable' }
  const fingerprints = new Set(respondingCandidates.map((candidate) => responses.get(candidate)))
  if (fingerprints.size !== 1) return { candidates: respondingCandidates, kind: 'conflict' }
  const canonicalSocket = respondingCandidates[0]
  if (!canonicalSocket) throw new LocalLoopbackOriginError('Ollama endpoint resolution was empty')
  return { canonicalSocket, kind: 'selected' }
}

/** Build bounded, non-displayable fingerprints from local observations. */
export const ollamaObservationFingerprints = (input: {
  modelManifestDigests: readonly string[]
  version: string
}): Pick<OllamaLoopbackEndpointEvidence, 'daemonFingerprint' | 'modelSetFingerprint'> => {
  if (input.version.length === 0 || input.version.length > 40 || input.modelManifestDigests.length > 100) {
    throw new LocalLoopbackOriginError('Ollama observation exceeds the protocol bound')
  }
  const modelManifestDigests = [...new Set(input.modelManifestDigests)].sort()
  if (!modelManifestDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest))) {
    throw new LocalLoopbackOriginError('Ollama model manifest digest is invalid')
  }
  const digest = (value: unknown): string => `sha256:${createHash('sha256')
    .update(canonicalExecutorJson(value))
    .digest('hex')}`
  return {
    daemonFingerprint: digest({ version: input.version }),
    modelSetFingerprint: digest({ modelManifestDigests }),
  }
}
