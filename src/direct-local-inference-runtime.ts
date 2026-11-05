/** The narrow Desktop-owned entry point for the same local-host protocol.
 *
 * This is deliberately not an executor: it accepts one native IPC document,
 * can only call the configured Nessie API and literal loopback Ollama, and
 * terminates when Desktop closes its stdin pipe.  It reuses the executor's
 * signed host loop rather than becoming a second relay implementation.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { LOCAL_INFERENCE_PROTOCOL_VERSION } from '@nessie/executor-protocol'
import { signLocalInferenceEnvelope } from '@nessie/local-inference-host'

import { createLocalInferenceDaemonApi, LocalInferenceApiError } from './local-inference-api.js'
import { startLocalInferenceHostSession, type LocalInferenceHostSession } from './local-inference-host-session.js'
import { LocalInferenceCoordinator } from './local-inference-coordinator.js'
import { EncryptedLocalInferenceReceiptJournal } from './local-inference-receipts.js'
import { discoverOllamaInventory } from './ollama-observed.js'

const RECEIPT_FILE = 'direct-local-inference-receipts.json'
const DIRECT_HEARTBEAT_INTERVAL_MS = 20_000

export type DirectLocalInferenceConfig = {
  apiBaseUrl: string
  connectionEpoch: string
  hostId: string
  machinePrivateKey: string
  organizationId: string
  receiptJournalKey: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const validConfig = (value: unknown): value is DirectLocalInferenceConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 6
    || typeof input.apiBaseUrl !== 'string'
    || typeof input.connectionEpoch !== 'string' || !/^[1-9][0-9]{0,18}$/.test(input.connectionEpoch)
    || typeof input.machinePrivateKey !== 'string'
    || typeof input.receiptJournalKey !== 'string'
    || typeof input.hostId !== 'string'
    || typeof input.organizationId !== 'string'
    || !UUID.test(input.hostId) || !UUID.test(input.organizationId)) return false
  try {
    return Buffer.from(input.machinePrivateKey, 'base64url').byteLength > 32
      && Buffer.from(input.receiptJournalKey, 'base64url').byteLength === 32
  } catch {
    return false
  }
}

const readConfigAndKeepLiveness = async (): Promise<DirectLocalInferenceConfig> => {
  const line = await new Promise<string>((resolve, reject) => {
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
    let received = false
    reader.once('line', (value) => { received = true; reader.close(); resolve(value) })
    reader.once('close', () => { if (!received) reject(new Error('Desktop local inference IPC ended before configuration.')) })
    reader.once('error', reject)
  })
  if (Buffer.byteLength(line, 'utf8') > 8_192) throw new Error('Desktop local inference IPC is too large.')
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { throw new Error('Desktop local inference IPC is malformed.') }
  if (!validConfig(parsed)) throw new Error('Desktop local inference IPC is malformed.')
  return parsed
}

const receiptStorage = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, RECEIPT_FILE)
  return {
    read: async () => {
      try { return JSON.parse(await readFile(path, 'utf8')) as { ciphertext: string; iv: string; tag: string; version: 1 } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    remove: async () => { await unlink(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
    write: async (value: unknown) => {
      const temporary = `${path}.${process.pid}.new`
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await file.sync() } finally { await file.close() }
      try { await rename(temporary, path) } finally { await unlink(temporary).catch(() => undefined) }
    },
  }
}

const directReceiptDirectory = (): string => {
  const value = process.env.NESSIE_DIRECT_LOCAL_INFERENCE_RECEIPT_DIR
  if (!value || !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('Desktop local inference receipt storage is unavailable.')
  }
  return value
}

type DirectHostSession = Pick<LocalInferenceHostSession, 'heartbeat' | 'refused' | 'stop'>

/**
 * Keep a direct Desktop host visible while a long local generation is running.
 * Its socket claims work as Nessie pushes it and reconnects on its own; the
 * inventory heartbeat is the only timer. A refused authority is not a reason
 * to keep going under a stale epoch: stop the literal-loopback request and let
 * Desktop start a fresh claimed process after the person repairs/re-pairs it.
 */
export const superviseDirectLocalInference = async (input: {
  heartbeatIntervalMs?: number
  session: DirectHostSession
  stopped: Promise<void>
}): Promise<void> => {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DIRECT_HEARTBEAT_INTERVAL_MS
  let stopping = false
  let heartbeat: Promise<void> | null = null
  let failure: unknown = null
  let resolveFailure: (() => void) | null = null
  const failed = new Promise<void>((resolve) => { resolveFailure = resolve })
  const fail = (error: unknown): void => { failure ??= error; resolveFailure?.() }
  void input.session.refused.then(() => fail(new Error('LOCAL_HOST_UNAVAILABLE')))
  const heartbeatTick = (): void => {
    if (stopping || heartbeat !== null) return
    heartbeat = input.session.heartbeat().catch((error: unknown) => {
      // Nessie refusing the host ends this process; a dropped socket does not.
      if (error instanceof LocalInferenceApiError && error.status !== undefined) fail(error)
    }).finally(() => { heartbeat = null })
  }
  const timer = setInterval(heartbeatTick, heartbeatIntervalMs)
  try {
    await Promise.race([input.stopped, failed])
  } finally {
    stopping = true
    clearInterval(timer)
    await Promise.allSettled([input.session.stop(), ...(heartbeat === null ? [] : [heartbeat])])
  }
  if (failure !== null) throw failure
}

/** Desktop's readiness: the socket is up and a fresh inventory reached the server. */
const firstHeartbeat = async (session: LocalInferenceHostSession): Promise<void> => {
  await Promise.race([
    session.connected,
    session.refused.then(() => { throw new Error('LOCAL_HOST_UNAVAILABLE') }),
  ])
  await session.heartbeat()
}

/** Starts the direct host after native code has proven the origin and supplied
 * secrets over its private pipe.  Nothing in this function accepts webview
 * input, a model name, an endpoint, headers, or command arguments. */
export const serveDirectLocalInference = async (): Promise<void> => {
  const config = await readConfigAndKeepLiveness()
  process.stdin.resume()
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: config.apiBaseUrl })
  const issued = await api.issueChallenge({ hostId: config.hostId })
  const claim = { challenge: issued.challenge }
  const envelope = signLocalInferenceEnvelope({
    body: claim,
    header: {
      connectionEpoch: config.connectionEpoch, hostId: config.hostId, organizationId: config.organizationId,
      protocolVersion: LOCAL_INFERENCE_PROTOCOL_VERSION, purpose: 'claim', sentAt: new Date().toISOString(), sequence: 1,
    },
    machinePrivateKey: config.machinePrivateKey,
  })
  const connection = await api.claim({ challenge: issued.challenge, envelope })
  // Discovery happens before advertising any availability. It is bounded to
  // the two literal loopback endpoints and does not issue a model request.
  const inventory = await discoverOllamaInventory()
  const journal = new EncryptedLocalInferenceReceiptJournal(
    await receiptStorage(directReceiptDirectory()),
    Buffer.from(config.receiptJournalKey, 'base64url'),
  )
  const session = startLocalInferenceHostSession({
    apiBaseUrl: config.apiBaseUrl,
    coordinator: await LocalInferenceCoordinator.open(),
    identity: {
      connectionEpoch: connection.connectionEpoch,
      hostId: config.hostId,
      machinePrivateKey: config.machinePrivateKey,
      organizationId: config.organizationId,
    },
    isPaused: () => false,
    journal,
    origin: inventory.origin,
  })
  // Desktop treats this one line as readiness. Do not expose a claimed epoch
  // until the socket is up and the first fresh inventory heartbeat reached the server.
  await firstHeartbeat(session)
  process.stdout.write(`${JSON.stringify({ connectionEpoch: connection.connectionEpoch })}\n`)
  let resolveStopped: (() => void) | null = null
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
  const stop = () => { resolveStopped?.() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.stdin.once('close', stop)
  process.stdin.once('end', stop)
  await superviseDirectLocalInference({ session, stopped })
  // A typed signed goodbye cannot be mistaken for a heartbeat. The server may
  // be unavailable during quit, in which case its short lease remains the
  // conservative fallback.
  const goodbye = { reason: 'desktop_exit' as const, receipt: createHash('sha256').update(config.hostId).digest('hex') }
  await api.goodbye({ envelope: signLocalInferenceEnvelope({
    body: goodbye,
    header: {
      connectionEpoch: connection.connectionEpoch, hostId: config.hostId, organizationId: config.organizationId,
      protocolVersion: LOCAL_INFERENCE_PROTOCOL_VERSION, purpose: 'goodbye', sentAt: new Date().toISOString(), sequence: 1,
    },
    machinePrivateKey: config.machinePrivateKey,
  }), goodbye }).catch(() => undefined)
}
