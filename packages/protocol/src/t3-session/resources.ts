import * as Schema from 'effect/Schema'
import { AssetResource, ThreadId, TurnItemId, CommandId, RuntimeRequestId } from '@nessie/t3-session-source/contracts'
import { ExecutorCommandAttachmentSchema, type ExecutorCommandAttachment } from '../executor-attachments.js'
import { ExecutorT3Routing } from './routing.js'

/** References to canonical Nessie Security records; no vault paths or values. */
export const ExecutorT3VaultPersistence = Schema.Union([
  Schema.Struct({ state: Schema.Literal('not_required') }),
  Schema.Struct({ state: Schema.Literal('saved'),
    bindings: Schema.Array(Schema.Struct({ secretId: Schema.String.check(Schema.isUUID()),
      fieldId: Schema.String.check(Schema.isNonEmpty()),
      answerIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    })).check(Schema.isMinLength(1)),
  }),
])

const ExistingAttachment = Schema.declare<ExecutorCommandAttachment>((value): value is ExecutorCommandAttachment =>
  ExecutorCommandAttachmentSchema.safeParse(value).success)

/** Bytes retain the existing signed command-attachment lane, never transcript JSON. */
export const ExecutorT3ByteDescriptor = Schema.Struct({
  ...ExecutorT3Routing.fields,
  kind: Schema.Literal('byte-descriptor'),
  resource: AssetResource,
  lane: Schema.Literal('executor-command-attachment'),
  attachment: ExistingAttachment,
})

/** A reference to existing one-use sealing; this envelope contains no answer. */
const SealedAnswerRouting = {
  ...ExecutorT3Routing.fields,
  kind: Schema.Literal('sealed-answer'),
  threadId: ThreadId,
  lane: Schema.Literal('executor-session-action'),
  actionId: Schema.String.check(Schema.isUUID()),
  commandId: CommandId,
  // The trusted ingress owner supplies this after canonical vault persistence.
  // not_required is valid only when the original answer supplied no secret.
  vaultPersistence: ExecutorT3VaultPersistence,
}
export const ExecutorT3SealedAnswerDescriptor = Schema.Union([
  Schema.Struct({ ...SealedAnswerRouting, method: Schema.Literal('secrets.answerRequest'), turnItemId: TurnItemId }),
  Schema.Struct({ ...SealedAnswerRouting, method: Schema.Literal('orchestration.dispatchCommand'),
    commandType: Schema.Literal('runtime-request.respond'), requestId: RuntimeRequestId }),
])
