const MAX_NATIVE_MESSAGE_BYTES = 256 * 1024

const nativeMessageFailure = (): Error => new Error('Native messaging frame is invalid.')

/**
 * Chrome native messages are little-endian JSON frames. The protocol permits
 * one MiB, but cookie-import envelopes deliberately use a much smaller cap.
 */
export const encodeChromeNativeMessage = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength === 0 || body.byteLength > MAX_NATIVE_MESSAGE_BYTES) throw nativeMessageFailure()
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32LE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

export const decodeChromeNativeMessages = (input: Buffer): { frames: unknown[]; remainder: Buffer } => {
  const frames: unknown[] = []
  let offset = 0
  while (offset + 4 <= input.byteLength) {
    const size = input.readUInt32LE(offset)
    if (size === 0 || size > MAX_NATIVE_MESSAGE_BYTES) throw nativeMessageFailure()
    const end = offset + 4 + size
    if (end > input.byteLength) break
    try {
      frames.push(JSON.parse(input.subarray(offset + 4, end).toString('utf8')) as unknown)
    } catch {
      throw nativeMessageFailure()
    }
    offset = end
  }
  if (input.byteLength - offset > MAX_NATIVE_MESSAGE_BYTES + 4) throw nativeMessageFailure()
  return { frames, remainder: input.subarray(offset) }
}
