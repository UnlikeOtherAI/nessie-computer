import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import {
  LocalLoopbackOriginError,
  assertLoopbackOrigin as assertSharedLoopbackOrigin,
} from '@nessie/local-inference-host'

/**
 * The executor's side of Ollama: detect it, and import a verified GGUF into it.
 *
 * Nessie does not ship an inference engine. It ships bytes and a pin, and asks
 * the Ollama the person installed to hold them under a namespaced model name.
 * That keeps the engine, its GPU story and its update cadence somebody else's
 * problem, and it means a person can see and delete what we put on their disk
 * with the tool they already use.
 *
 * **This module is the executor's only Ollama transport, and that is load
 * bearing.** Everything else in `executor/src` dials through
 * `@nessie/runtime`'s pinned transport, which refuses loopback by design —
 * that is exactly what makes it an SSRF boundary, and it is why it cannot
 * express a call to a loopback daemon. So this file holds the egress
 * allowlist's one Ollama entry, and every future Ollama call (the delegation
 * loop's `/api/chat` included) belongs here rather than in a second module
 * with a second entry: that list only shrinks.
 *
 * What earns the entry is `assertLoopbackOrigin` below. The origin is not a
 * string this module trusts — it is re-derived on every call and must be an
 * address that cannot leave the machine, so this is a loopback transport
 * rather than a general HTTP client that happens to point at one.
 *
 * **What it cannot promise.** Ollama's API has no authentication, so this
 * talks to a *port*, not provably to Ollama: whoever binds 11434 first is
 * Ollama as far as this code is concerned. That is inherent to Ollama and is
 * not fixable here, but it is the real trust assumption — worth stating
 * plainly, because the delegation loop will later post host text to this same
 * origin.
 */

/** Where Ollama listens unless the reviewed policy says otherwise. */
export const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434'

/**
 * The floor is the release whose `/api/create` takes a `files` map of blob
 * digests. Below it the import path below does not exist.
 */
export const MINIMUM_OLLAMA_VERSION = '0.34.0'

/** A blob push streams gigabytes; the rest of these calls are small and quick. */
const CONTROL_TIMEOUT_MS = 10_000
const IMPORT_TIMEOUT_MS = 30 * 60_000

/** A JSON document, or the GGUF itself as a stream. Nothing else is ever sent. */
type OllamaRequestBody = string | NodeReadableStream

export type OllamaFetch = (
  url: string,
  init: {
    body?: OllamaRequestBody
    duplex?: 'half'
    headers?: Record<string, string>
    method?: string
    signal?: AbortSignal
  },
) => Promise<Response>

export const defaultOllamaFetch: OllamaFetch = (url, init) =>
  // Global fetch follows redirects by default, which would let anything
  // answering on 11434 bounce a request — or a replayed POST body — off the
  // machine. A loopback daemon has no business redirecting us anywhere.
  fetch(url, { ...init, redirect: 'error' } as RequestInit & { duplex?: 'half' })

/** Compatibility alias; shared host code owns the literal-loopback admission. */
export class OllamaOriginError extends LocalLoopbackOriginError {}

export const assertLoopbackOrigin = (origin: string): string => {
  try {
    return assertSharedLoopbackOrigin(origin)
  } catch (error) {
    if (error instanceof LocalLoopbackOriginError) throw new OllamaOriginError(error.message)
    throw error
  }
}

/** `0.34.1` against `0.34.0`, numerically and per segment; a version we cannot read is not a version that passes. */
export const meetsVersionFloor = (observed: string, floor: string): boolean => {
  const parse = (value: string): number[] | undefined => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
  }
  const left = parse(observed)
  const right = parse(floor)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

export type OllamaPresence =
  | { available: false; reason: 'unreachable' }
  | { available: false; reason: 'too_old'; version: string }
  | { available: true; version: string }

export const detectOllama = async (
  origin: string = DEFAULT_OLLAMA_ORIGIN,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<OllamaPresence> => {
  // Outside the catch on purpose: an origin the policy should never have
  // contained is a configuration defect, and reporting it as "no daemon here"
  // would hide it behind a plausible-looking absence.
  const base = assertLoopbackOrigin(origin)
  try {
    const response = await fetchImpl(`${base}/api/version`, {
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    if (!response.ok) return { available: false, reason: 'unreachable' }
    const body: unknown = await response.json()
    const version = (body as { version?: unknown } | null)?.version
    if (typeof version !== 'string') return { available: false, reason: 'unreachable' }
    return meetsVersionFloor(version, MINIMUM_OLLAMA_VERSION)
      ? { available: true, version }
      : { available: false, reason: 'too_old', version }
  } catch {
    return { available: false, reason: 'unreachable' }
  }
}

export type ImportFailureReason =
  /** Ollama hashed the body and got something other than the digest in the URL. */
  | 'digest_rejected'
  /** The model was assembled but does not report the blob we pinned. */
  | 'digest_unconfirmed'
  | 'unreachable'

export type ImportOutcome = { ok: true } | { ok: false; reason: ImportFailureReason; detail?: string }

/** Ollama answers 404 for a digest it does not hold, which is how a re-import skips the upload. */
export const blobExists = async (
  origin: string,
  digest: string,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<boolean> => {
  const base = assertLoopbackOrigin(origin)
  try {
    const response = await fetchImpl(`${base}/api/blobs/sha256:${digest}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    return response.status === 200
  } catch {
    return false
  }
}

/**
 * Hand Ollama the file, with the digest in the URL.
 *
 * This is the second of the two independent checks: our own streamed hash said
 * these bytes are the pin, and now a different process hashes them again and
 * answers `400` if it disagrees. A corrupted file has to defeat both.
 */
export const pushBlob = async (
  origin: string,
  digest: string,
  path: string,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<ImportOutcome> => {
  const base = assertLoopbackOrigin(origin)
  try {
    const response = await fetchImpl(`${base}/api/blobs/sha256:${digest}`, {
      method: 'POST',
      body: Readable.toWeb(createReadStream(path)),
      duplex: 'half',
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    })
    if (response.status === 400) return { ok: false, reason: 'digest_rejected' }
    if (!response.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${response.status}` }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'blob upload failed',
    }
  }
}

export const createModel = async (
  origin: string,
  modelName: string,
  files: Record<string, string>,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<ImportOutcome> => {
  const base = assertLoopbackOrigin(origin)
  try {
    const response = await fetchImpl(`${base}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelName, files, stream: false }),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${response.status}` }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'create failed',
    }
  }
}

/**
 * The blob digests the created model was assembled from.
 *
 * Ollama 0.34.x has no API that lists a model's layer digests: `/api/show`
 * returns `license, modelfile, parameters, template, details, model_info,
 * projector_info, capabilities, modified_at, requires` and nothing else, and
 * `/api/tags` reports the manifest hash rather than the blobs. The one place a
 * blob digest appears is the rendered `modelfile`, as the path in its `FROM`
 * lines:
 *
 * ```
 * FROM /home/me/.ollama/models/blobs/sha256-1278394b6936…a606
 * ```
 *
 * **What this proves, precisely.** That `modelfile` is rendered from the
 * manifest `/api/create` wrote from the `files` map we sent, so agreement is a
 * round trip: it confirms the model was assembled from the blob we named, not
 * that anyone hashed it a second time here. The independent hash is `pushBlob`
 * — Ollama refuses a body that is not the digest in the URL. This step catches
 * the different failure of a model that was created from some other blob, or
 * not created at all.
 */
export const modelSourceDigests = async (
  origin: string,
  modelName: string,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<string[] | undefined> => {
  const base = assertLoopbackOrigin(origin)
  try {
    const response = await fetchImpl(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    const modelfile = (body as { modelfile?: unknown } | null)?.modelfile
    if (typeof modelfile !== 'string') return undefined
    return parseModelfileDigests(modelfile)
  } catch {
    return undefined
  }
}

/**
 * Read the blob digests out of a rendered modelfile.
 *
 * The digest is the last path segment of a `FROM` line, spelled `sha256-<hex>`
 * on disk. A `FROM` naming another model rather than a blob path has no digest
 * and contributes nothing.
 */
export const parseModelfileDigests = (modelfile: string): string[] => {
  const found = new Set<string>()
  let insideQuotedBlock = false
  for (const line of modelfile.split(/\r?\n/)) {
    // `TEMPLATE """…"""` and `SYSTEM """…"""` carry arbitrary text, and that
    // text comes from the GGUF rather than from us. A line inside one that
    // reads like `FROM …sha256-<our pin>` must not be mistaken for a model
    // source, or a model assembled from some other blob could present our
    // digest and be accepted. An odd number of fences on a line toggles.
    const fences = (line.match(/"""/g) ?? []).length
    const startedQuoted = insideQuotedBlock
    if (fences % 2 === 1) insideQuotedBlock = !insideQuotedBlock
    if (startedQuoted) continue
    if (!/^\s*FROM\s/i.test(line)) continue
    const match = /sha256[-:]([0-9a-f]{64})\s*$/i.exec(line)
    if (match?.[1]) found.add(match[1].toLowerCase())
  }
  return [...found]
}

export type ImportRequest = {
  digest: string
  fileName: string
  modelName: string
  origin?: string
  path: string
  fetchImpl?: OllamaFetch
}

/**
 * Push, assemble, and only then believe it.
 *
 * The confirmation step is what makes the pin mean something end to end: the
 * model is advertised as ready only after Ollama itself reports holding the
 * digest the catalogue named.
 */
export const importVerifiedModel = async (request: ImportRequest): Promise<ImportOutcome> => {
  const origin = request.origin ?? DEFAULT_OLLAMA_ORIGIN
  const fetchImpl = request.fetchImpl ?? defaultOllamaFetch

  if (!(await blobExists(origin, request.digest, fetchImpl))) {
    const pushed = await pushBlob(origin, request.digest, request.path, fetchImpl)
    if (!pushed.ok) return pushed
  }

  const created = await createModel(
    origin,
    request.modelName,
    { [request.fileName]: `sha256:${request.digest}` },
    fetchImpl,
  )
  if (!created.ok) return created

  const digests = await modelSourceDigests(origin, request.modelName, fetchImpl)
  if (digests === undefined) {
    return { ok: false, reason: 'digest_unconfirmed', detail: 'show returned nothing readable' }
  }
  if (!digests.includes(request.digest)) {
    return { ok: false, reason: 'digest_unconfirmed', detail: 'created model does not hold the pinned blob' }
  }
  return { ok: true }
}
