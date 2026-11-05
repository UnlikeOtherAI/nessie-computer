import { createHash } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { CodingBridgeError } from '../coding-session/bridge-tools.js'
import { createJsonExclusive, ensureCodingStateDir, readJson, writeJsonAtomic } from '../coding-session/session-files.js'
import { channelInboxDir } from './channel-files.js'
import { CodexOperationRejected } from './codex-rpc.js'

type Result = Record<string, unknown>
type Delivery = { fingerprint: string; sessionId: string; createdAt: number; result: Result }
const LIMIT = 4_096
const keyOf = (commandId: string): string => createHash('sha256').update(commandId).digest('hex')
const directoryOf = (stateDir: string): string => join(stateDir, 'existing-deliveries')
const latestPath = (stateDir: string, sessionId: string): string => (
  join(directoryOf(stateDir), 'latest', `${sessionId}.json`)
)

const reconcile = async (stateDir: string, key: string, delivery: Delivery): Promise<Result> => {
  if (delivery.result.state !== 'accepted_locally') return delivery.result
  const inbox = channelInboxDir(stateDir, delivery.sessionId)
  const receipt = await readJson<Result>(join(inbox, `${key}.result`))
  let result: Result | undefined
  if (receipt && receipt.providerMessageId === delivery.result.providerMessageId
    && ['written_to_transport', 'cancelled'].includes(String(receipt.state))) result = receipt
  else if (Date.now() - delivery.createdAt > 65_000) {
    // A claimed event may have reached stdio before the process stopped. Do not replay it.
    result = { ...delivery.result, state: 'outcome_unknown',
      behavior: 'The Claude channel did not return a delivery receipt. This input will not be replayed.' }
  }
  if (!result) return delivery.result
  delivery.result = { ...result, sessionId: delivery.sessionId }
  await writeJsonAtomic(join(directoryOf(stateDir), `${key}.json`), delivery)
  for (const suffix of ['pending', 'claimed', 'result']) {
    await unlink(join(inbox, `${key}.${suffix}`)).catch(() => undefined)
  }
  return delivery.result
}

export const latestExistingDelivery = async (stateDir: string, sessionId: string): Promise<Result | undefined> => {
  const latest = await readJson<{ key: string }>(latestPath(stateDir, sessionId))
  if (!latest || !/^[a-f0-9]{64}$/u.test(latest.key)) return undefined
  const delivery = await readJson<Delivery>(join(directoryOf(stateDir), `${latest.key}.json`))
  return delivery?.sessionId === sessionId ? reconcile(stateDir, latest.key, delivery) : undefined
}

/** Claim before provider I/O. Receipts are retained; a full journal refuses new writes rather than losing dedupe. */
export const deliverOnce = async (input: {
  stateDir: string
  commandId: string
  ownerKey: string
  sessionId: string
  action: string
  message: string
  send: (eventId: string) => Promise<Result>
}): Promise<Result> => {
  const directory = directoryOf(input.stateDir)
  await ensureCodingStateDir(directory)
  const key = keyOf(input.commandId)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.ownerKey, input.sessionId, input.action, input.message])).digest('hex')
  const path = join(directory, `${key}.json`)
  const prior = await readJson<Delivery>(path)
  if (!prior && (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).length >= LIMIT) {
    throw new CodingBridgeError('coding_session_delivery_limit', 'The local delivery journal is full. No input was sent.')
  }
  const unknown = { sessionId: input.sessionId, state: 'outcome_unknown', providerMessageId: input.commandId }
  const delivery: Delivery = { fingerprint, sessionId: input.sessionId, createdAt: Date.now(), result: unknown }
  if (prior || !await createJsonExclusive(path, delivery)) {
    const saved = prior ?? await readJson<Delivery>(path)
    if (saved?.fingerprint !== fingerprint) {
      throw new CodingBridgeError('coding_session_command_conflict', 'This command ID was already used for another action.')
    }
    return reconcile(input.stateDir, key, saved)
  }
  await ensureCodingStateDir(join(directory, 'latest'))
  await writeJsonAtomic(latestPath(input.stateDir, input.sessionId), { key })
  const result = await input.send(key).catch((error: unknown) => error instanceof CodexOperationRejected
    ? { state: 'failed', providerMessageId: input.commandId, reason: error.message } : unknown)
  delivery.result = { ...result, sessionId: input.sessionId }
  await writeJsonAtomic(path, delivery)
  return delivery.result
}
