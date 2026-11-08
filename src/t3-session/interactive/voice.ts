import * as Schema from 'effect/Schema'
import {
  SpeechStreamCommand, SpeechStreamEvent, SPEECH_MAX_OPTIONS_BYTES,
  SPEECH_STREAM_MAX_CHUNK_BYTES, SPEECH_STREAM_MAX_QUEUED_BYTES,
} from '@nessie/t3-session-source/contracts'
import { InteractiveFailure, requireInteractive } from './operations.js'
import type { InteractiveSource } from './scope.js'

export interface VoiceDestination {
  readonly executorId: string
  readonly environmentId: string
}

function decodeJson<A, E>(schema: Schema.Codec<A, E>, text: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text), { onExcessProperty: 'error' })
  } catch { throw new InteractiveFailure('invalid_input') }
}

/** Validates one original voice connection. It neither transcribes nor chooses a destination.
 * Disconnect discards it; PCM is never replayed into another transcription attempt.
 */
export class InteractiveVoiceProtocol {
  readonly source: InteractiveSource
  readonly destination: Readonly<VoiceDestination>
  #state: 'new' | 'starting' | 'ready' | 'finishing' | 'closed' = 'new'
  #bytes = 0
  readonly #pending: number[] = []
  #revision: number | undefined

  constructor(source: InteractiveSource, selectedDestination: VoiceDestination, admittedDestination: VoiceDestination) {
    requireInteractive(selectedDestination.executorId === admittedDestination.executorId
      && selectedDestination.environmentId === admittedDestination.environmentId, 'resource_mismatch')
    this.source = Object.freeze({ ...source })
    this.destination = Object.freeze({ ...selectedDestination })
  }

  command(text: string): typeof SpeechStreamCommand.Type {
    requireInteractive(Buffer.byteLength(text, 'utf8') <= SPEECH_MAX_OPTIONS_BYTES, 'stream_capacity')
    const command = decodeJson(SpeechStreamCommand, text)
    if (command.type === 'start') {
      requireInteractive(this.#state === 'new', 'invalid_voice_state')
      this.#state = 'starting'
    } else {
      requireInteractive(this.#state === 'ready', 'invalid_voice_state')
      this.#state = 'finishing'
    }
    return command
  }

  pcm(bytes: Uint8Array): Uint8Array {
    requireInteractive(this.#state === 'ready', 'invalid_voice_state')
    requireInteractive(bytes.byteLength > 0 && bytes.byteLength % 4 === 0
      && bytes.byteLength <= SPEECH_STREAM_MAX_CHUNK_BYTES, 'invalid_pcm')
    requireInteractive(this.#bytes + bytes.byteLength <= SPEECH_STREAM_MAX_QUEUED_BYTES, 'stream_capacity')
    // Match the original speech socket's bounded two-frame demand queue.
    requireInteractive(this.#pending.length < 2, 'stream_capacity')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset < bytes.byteLength; offset += 4) {
      const sample = view.getFloat32(offset, true)
      requireInteractive(Number.isFinite(sample) && sample >= -1 && sample <= 1, 'invalid_pcm')
    }
    this.#bytes += bytes.byteLength
    this.#pending.push(bytes.byteLength)
    return Uint8Array.from(bytes)
  }

  event(text: string): typeof SpeechStreamEvent.Type {
    requireInteractive(Buffer.byteLength(text, 'utf8') <= 1024 * 1024, 'stream_capacity')
    requireInteractive(this.#state !== 'new' && this.#state !== 'closed', 'invalid_voice_state')
    const event = decodeJson(SpeechStreamEvent, text)
    switch (event.type) {
      case 'ready':
        requireInteractive(this.#state === 'starting', 'invalid_voice_state')
        this.#state = 'ready'
        break
      case 'update':
        requireInteractive(this.#state === 'ready' || this.#state === 'finishing', 'invalid_voice_state')
        requireInteractive(this.#pending.length > 0, 'invalid_voice_state')
        // Native feed can ACK without revising text; equal revisions are original behavior.
        requireInteractive(this.#revision === undefined || event.revision >= this.#revision,
          'source_sequence_regressed')
        this.#revision = event.revision
        this.#bytes -= this.#pending.shift()!
        break
      case 'finished':
        requireInteractive(this.#state === 'finishing' && this.#pending.length === 0, 'invalid_voice_state')
        this.#state = 'closed'
        break
      case 'error':
        this.cancel()
    }
    return event
  }

  cancel(): void { this.#state = 'closed'; this.#bytes = 0; this.#pending.length = 0 }
}
