import { z } from 'zod'

import {
  ExecutorCommandIdSchema,
  ExecutorDaemonSignatureSchema,
  ExecutorIdSchema,
  Sha256DigestSchema,
} from './executor.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * Images a local program returns leave its result as attachments.
 *
 * A Kelpie screenshot is 0.1–0.9 MB and arrives three times in one MCP result
 * (its text JSON, an image item and `structuredContent`), while a terminal
 * result is capped at 64 KiB. So the daemon decodes each image item, keeps the
 * bytes beside its command, and leaves a small reference in the result; the
 * bytes travel on their own signed request, before the result's receipt. The
 * caps and the type check below are the same on both sides of that request:
 * the daemon applies them when it extracts, and the control plane again when
 * it accepts an upload.
 */

/** The image types every vision endpoint Nessie drives decodes. */
export const EXECUTOR_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const ExecutorImageMimeTypeSchema = z.enum(EXECUTOR_IMAGE_MIME_TYPES)
export type ExecutorImageMimeType = z.infer<typeof ExecutorImageMimeTypeSchema>

/** Images kept from one result — the prompt's own image cap. */
export const EXECUTOR_RESULT_IMAGE_MAXIMUM = 6
/** One decoded image — the size the prompt loader still inlines. */
export const EXECUTOR_RESULT_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** Every image of one result, decoded, together. */
export const EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES = 8 * 1024 * 1024
/** Standard padded base64 of the largest image. */
export const EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH = 4 * Math.ceil(EXECUTOR_RESULT_IMAGE_MAX_BYTES / 3)

const asciiAt = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The type the bytes themselves say they are, from their leading bytes, or
 * null for anything that is not one of the four. A program's declared
 * `mimeType` is only a claim: an image is kept when this agrees with it.
 */
export const sniffExecutorImageMimeType = (bytes: Uint8Array): ExecutorImageMimeType | null => {
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif'
  return null
}

/**
 * What an image item of a result becomes on the machine. It names the bytes by
 * digest and size and carries none of them; the control plane resolves the
 * digest to the attachment the daemon uploaded for the same command.
 */
export const ExecutorImageReferenceSchema = z
  .object({
    type: z.literal('image'),
    mimeType: ExecutorImageMimeTypeSchema,
    attachmentDigest: Sha256DigestSchema,
    byteLength: z.number().int().positive().max(EXECUTOR_RESULT_IMAGE_MAX_BYTES),
  })
  .strict()
export type ExecutorImageReference = z.infer<typeof ExecutorImageReferenceSchema>

/** What every other copy of a kept image's base64 in the same result becomes. */
export const executorImageAttachmentMarker = (digest: string): string => `[image: attachment ${digest}]`

/** What an image that is not delivered becomes, wherever it was in the result. */
export const executorImageUnavailableText = (reason: string): string => `[image unavailable: ${reason}]`

/** The signed description of one upload; the bytes ride beside it. */
export const ExecutorCommandAttachmentSchema = z
  .object({
    byteLength: z.number().int().positive().max(EXECUTOR_RESULT_IMAGE_MAX_BYTES),
    commandId: ExecutorCommandIdSchema,
    digest: Sha256DigestSchema,
    mimeType: ExecutorImageMimeTypeSchema,
    occurredAt: TimestampSchema,
  })
  .strict()
export type ExecutorCommandAttachment = z.infer<typeof ExecutorCommandAttachmentSchema>

const decodedBase64Length = (value: string): number =>
  (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)

/**
 * `POST /api/executor-daemon/commands/attachment`, signed under the daemon's
 * `attachment` domain over `{connectionEpoch, executorId, attachment}`. The
 * signature does not cover `dataBase64`; it covers `attachment.digest`, which
 * the control plane recomputes from the decoded bytes.
 */
export const ExecutorDaemonCommandAttachmentRequestSchema = z
  .object({
    attachment: ExecutorCommandAttachmentSchema,
    connectionEpoch: z.string().regex(/^\d+$/),
    dataBase64: z
      .string()
      .min(4)
      .max(EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    executorId: ExecutorIdSchema,
    signature: ExecutorDaemonSignatureSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dataBase64.length % 4 !== 0
      || decodedBase64Length(value.dataBase64) !== value.attachment.byteLength
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The attachment data is not padded base64 of exactly byteLength bytes.',
        path: ['dataBase64'],
      })
    }
  })
export type ExecutorDaemonCommandAttachmentRequest = z.infer<
  typeof ExecutorDaemonCommandAttachmentRequestSchema
>

export const ExecutorDaemonCommandAttachmentResponseSchema = z
  .object({ recorded: z.literal(true) })
  .strict()
export type ExecutorDaemonCommandAttachmentResponse = z.infer<
  typeof ExecutorDaemonCommandAttachmentResponseSchema
>
