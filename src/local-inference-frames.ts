import { LOCAL_INFERENCE_MAX_FRAME_BYTES } from '@nessie/executor-protocol'

export type LocalInferenceStreamFrameType = 'output_text.delta' | 'reasoning_text.delta'

const payload = (type: LocalInferenceStreamFrameType, text: string): string => JSON.stringify({ type, text })
const encoded = (type: LocalInferenceStreamFrameType, text: string): string => (
  Buffer.from(payload(type, text), 'utf8').toString('base64url')
)

/**
 * Split at Unicode code points and cap the encoded wire payload, not just its
 * text. The stream's final frame is always sent, even with no text left, so a
 * watching worker learns where the stream ended.
 */
export const encodeLocalInferenceFrames = (
  type: LocalInferenceStreamFrameType,
  text: string,
  final = false,
): string[] => {
  const frames: string[] = []
  let current = ''
  for (const codePoint of text) {
    const candidate = current + codePoint
    if (Buffer.byteLength(payload(type, candidate), 'utf8') <= LOCAL_INFERENCE_MAX_FRAME_BYTES) {
      current = candidate
      continue
    }
    if (!current) throw new Error('A local inference output character exceeds the frame limit.')
    frames.push(encoded(type, current))
    current = codePoint
  }
  if (current || final && frames.length === 0) frames.push(encoded(type, current))
  return frames
}
