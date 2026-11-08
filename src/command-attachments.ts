import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  EXECUTOR_RESULT_IMAGE_MAX_BYTES,
  ExecutorCommandIdSchema,
  type ExecutorCommandEnvelope,
  type ExecutorImageMimeType,
  type ExecutorImageReference,
} from '@nessie/executor-protocol'

import { EXECUTOR_API_REQUEST_TIMEOUT_MS, ExecutorApiError } from './api-client.js'
import type { ExecutorCommandJournal } from './command-journal.js'
import {
  executorMcpImageReferences,
  withdrawExecutorMcpImage,
  type ExecutorMcpImage,
} from './mcp-images.js'
import { assertOrdinaryDirectory, missing } from './sandbox-layout.js'
import { ensureExecutorRuntimeDirectory } from './state-store.js'

/**
 * A result's images between the call that returned them and the receipt that
 * reports it.
 *
 * The bytes are written as raw sidecars
 * `<runtimeDir>/attachments/<commandId>/<sha256 hex>.bin` while the command
 * executes, so they are on disk, fsynced, before the `result_pending` journal
 * entry that references them is saved. Before the receipt, each referenced
 * image is uploaded on its own signed request; a restart between an upload and
 * the receipt uploads again, which the control plane accepts as the same
 * attachment. An acknowledged receipt removes its command's sidecars, and the
 * daemon's start removes every command's but those the journal still holds.
 */

const ATTACHMENTS_DIRECTORY = 'attachments'

export type ExecutorCommandAttachmentStore = {
  /** The kept bytes of one image, or null when they are missing or no longer match their digest. */
  read: (commandId: string, digest: string) => Promise<Buffer | null>
  remove: (commandId: string) => Promise<void>
  /** Removes every command's sidecars except those of `keep`. */
  sweep: (keep: readonly string[]) => Promise<void>
  write: (commandId: string, images: readonly ExecutorMcpImage[]) => Promise<void>
}

const sidecarName = (digest: string): string => {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1]
  if (!hex) throw new Error('An attachment digest names no sidecar.')
  return `${hex}.bin`
}

const digestOf = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/**
 * One store secures the runtime directory once, as the recovery journal's
 * does: on Windows that proof spawns the packaged native helper, and the store
 * is touched on every command. The sidecar folders beneath it are created
 * owner-only the way the sandboxes' are.
 */
export const createExecutorCommandAttachmentStore = (
  stateDir: string,
  deps: { ensureRuntimeDirectory?: (stateDir: string) => Promise<string> } = {},
): ExecutorCommandAttachmentStore => {
  const ensureRuntimeDirectory = deps.ensureRuntimeDirectory ?? ensureExecutorRuntimeDirectory
  let secured: Promise<string> | undefined
  const root = async (): Promise<string> => {
    secured ??= ensureRuntimeDirectory(stateDir)
    try {
      return resolve(await secured, ATTACHMENTS_DIRECTORY)
    } catch (error) {
      secured = undefined
      throw error
    }
  }
  // A command id is a UUID by schema, which is what makes it a safe name.
  const commandDirectory = async (commandId: string): Promise<string> =>
    resolve(await root(), ExecutorCommandIdSchema.parse(commandId))

  return {
    read: async (commandId, digest) => {
      const path = resolve(await commandDirectory(commandId), sidecarName(digest))
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.size > EXECUTOR_RESULT_IMAGE_MAX_BYTES) return null
        const bytes = await readFile(path)
        return digestOf(bytes) === digest ? bytes : null
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
    remove: async (commandId) => {
      await rm(await commandDirectory(commandId), { force: true, recursive: true })
    },
    sweep: async (keep) => {
      const directory = await root()
      let entries: string[]
      try {
        entries = await readdir(directory)
      } catch (error) {
        if (missing(error)) return
        throw error
      }
      await Promise.all(entries
        .filter((entry) => !keep.includes(entry))
        .map((entry) => rm(resolve(directory, entry), { force: true, recursive: true })))
    },
    write: async (commandId, images) => {
      const directory = await commandDirectory(commandId)
      await mkdir(directory, { mode: 0o700, recursive: true })
      await assertOrdinaryDirectory(directory, 'The attachment folder is unavailable.')
      for (const image of images) {
        const handle = await open(resolve(directory, sidecarName(image.digest)), 'w', 0o600)
        try {
          await handle.writeFile(image.bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    },
  }
}

/**
 * At daemon start, every sidecar folder but those of commands the journal
 * still holds is a leftover of a command that already ended. A journal that
 * cannot be read removes nothing: which folders are current is exactly what
 * it cannot say.
 */
export const sweepExecutorCommandAttachments = async (
  journal: Pick<ExecutorCommandJournal, 'list'>,
  sidecars: Pick<ExecutorCommandAttachmentStore, 'sweep'>,
): Promise<void> => {
  const held = await journal.list()
  await sidecars.sweep(held.map((record) => record.command.commandId))
}

/** The slow uplink an upload is sized for — 2 Mbit/s — in bytes a millisecond. */
export const EXECUTOR_ATTACHMENT_UPLINK_BYTES_PER_MS = 250

/**
 * What Nessie spends on one image before it answers, on a busy instance: the
 * digest, the executor lock, metadata stripping, the thumbnail, the storage
 * write and the quota transaction.
 */
export const EXECUTOR_ATTACHMENT_SERVER_ALLOWANCE_MS = 2_000

/**
 * How long one upload may take: the ordinary request deadline — the server's
 * work behind the answer is at least an ordinary request's — plus the bytes'
 * transfer on a slow uplink. It is a bound on one request, not a share of the
 * upload budget: a deadline that covered only the transfer timed a busy
 * server out on a result it went on to store. What bounds the retries is the
 * command's expiry (`deliverExecutorCommandAttachments`).
 */
export const executorAttachmentUploadTimeoutMs = (byteLength: number): number =>
  EXECUTOR_API_REQUEST_TIMEOUT_MS + Math.ceil(
    Math.min(Math.max(byteLength, 0), EXECUTOR_RESULT_IMAGE_MAX_BYTES) / EXECUTOR_ATTACHMENT_UPLINK_BYTES_PER_MS,
  )

export type ExecutorAttachmentUpload = (image: {
  bytes: Buffer
  commandId: ExecutorCommandEnvelope['commandId']
  digest: string
  mimeType: ExecutorImageMimeType
}) => Promise<void>

/**
 * A delivery the next poll makes again: an upload timed out, met a 5xx, a 408
 * or a 429, or lost its connection before its command expired. It is its own
 * error because it says nothing about the machine's other sessions, which a
 * failed poll otherwise stops.
 */
export class ExecutorAttachmentDeliveryDeferred extends Error {
  constructor(cause: unknown) {
    super(`An image upload will be made again: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'ExecutorAttachmentDeliveryDeferred'
  }
}

/** Whether a failed command poll must stop the machine's browser, command and coding sessions. */
export const commandPollFailureStopsSessions = (error: unknown): boolean =>
  !(error instanceof ExecutorAttachmentDeliveryDeferred)

// A fenced or stale connection is not a refusal of the image: the receipt
// behind the upload fails the same way until the daemon reconnects, and it is
// thrown as it came, like any failed poll's.
const CONNECTION_CODES = new Set(['EXECUTOR_CONNECTION_FENCED', 'EXECUTOR_HEARTBEAT_STALE'])

const connectionLost = (error: unknown): boolean =>
  error instanceof ExecutorApiError && CONNECTION_CODES.has(error.code ?? '')

const uploadWasRefused = (error: unknown): error is ExecutorApiError => (
  error instanceof ExecutorApiError
  && error.status !== undefined
  && error.status >= 400
  && error.status < 500
  && error.status !== 408
  && error.status !== 429
  && !connectionLost(error)
)

const MAX_REASON_LENGTH = 200

const refusalReason = (error: ExecutorApiError): string => {
  const message = error.message.replace(/\s+/g, ' ').trim()
  const bounded = message.length <= MAX_REASON_LENGTH ? message : `${message.slice(0, MAX_REASON_LENGTH - 1)}…`
  return `Nessie refused it (${bounded})`
}

const LOST_REASON = 'the image was lost on this machine before it could be delivered'
const EXPIRED_REASON = 'it could not be delivered before its command expired'

/** Progress through one result's images, as the journal keeps it. */
export type ExecutorAttachmentDeliveryProgress = {
  /** Digests Nessie has answered for; a later pass does not send them again. */
  delivered: string[]
  result: Record<string, unknown>
}

/**
 * Uploads every image `result` references that Nessie has not already
 * answered for, and answers the result its receipt must carry.
 *
 * Each answered upload is journaled as delivered, so a pass that fails later
 * does not send its bytes again. A refusal (a 4xx) is terminal: that image is
 * withdrawn — its reference and markers become `[image unavailable:
 * <reason>]` — and the rewritten result is journaled before anything else is
 * sent, so the refused upload is never made again and the receipt's digest is
 * computed from what was journaled. A sidecar that is gone or no longer
 * matches is withdrawn the same way.
 *
 * Anything else — a timeout, a 5xx, a lost connection — is retried with the
 * command's next report while it is live, as `ExecutorAttachmentDeliveryDeferred`
 * (a fenced or stale connection throws as itself). Once the command has
 * expired, an image gets one more attempt and a failure withdraws it: the
 * command's record, its slot and its session's place in "Now working" must not
 * be held for good by a slow uplink or a lasting storage fault. Nessie still takes a late result,
 * so a daemon that restarts after the expiry still delivers what it can.
 */
export const deliverExecutorCommandAttachments = async (input: {
  command: ExecutorCommandEnvelope
  delivered?: readonly string[]
  journal: (progress: ExecutorAttachmentDeliveryProgress) => Promise<void>
  /** The clock the expiry is read against; the wall clock unless a test says otherwise. */
  now?: () => number
  onWithdrawn?: (reference: ExecutorImageReference, reason: string) => void
  result: Record<string, unknown>
  sidecars: Pick<ExecutorCommandAttachmentStore, 'read'>
  upload: ExecutorAttachmentUpload
}): Promise<Record<string, unknown>> => {
  const now = input.now ?? Date.now
  const expiresAt = Date.parse(input.command.expiresAt)
  let result = input.result
  const delivered = [...(input.delivered ?? [])]
  for (const reference of executorMcpImageReferences(input.result)) {
    if (delivered.includes(reference.attachmentDigest)) continue
    const bytes = await input.sidecars.read(input.command.commandId, reference.attachmentDigest)
    let reason: string | undefined
    if (!bytes) {
      reason = LOST_REASON
    } else {
      // Read before the attempt: an attempt begun before the expiry that
      // fails after it is still retried once more.
      const expired = !(now() < expiresAt)
      try {
        await input.upload({
          bytes,
          commandId: input.command.commandId,
          digest: reference.attachmentDigest,
          mimeType: reference.mimeType,
        })
      } catch (error) {
        if (uploadWasRefused(error)) reason = refusalReason(error)
        else if (expired) reason = EXPIRED_REASON
        else if (connectionLost(error)) throw error
        else throw new ExecutorAttachmentDeliveryDeferred(error)
      }
    }
    if (reason === undefined) {
      delivered.push(reference.attachmentDigest)
    } else {
      input.onWithdrawn?.(reference, reason)
      result = withdrawExecutorMcpImage(result, reference.attachmentDigest, reason)
    }
    await input.journal({ delivered: [...delivered], result })
  }
  return result
}
