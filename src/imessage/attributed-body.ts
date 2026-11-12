/**
 * The plain text inside a Messages `attributedBody`: an `NSAttributedString`
 * archived as an NSArchiver typedstream. Messages leaves `message.text` empty
 * for some messages and keeps the text only here.
 *
 * The archive names the class `NSString`, then its version and the type code
 * `+` (a C string), then the length as a typedstream integer — one byte below
 * 0x80, or 0x81 followed by a little-endian uint16, or 0x82 followed by a
 * little-endian uint32 — then that many UTF-8 bytes. Anything else, and any
 * length that runs past the blob, reads as no text rather than a guess.
 */
const NSSTRING = Buffer.from('NSString', 'latin1')
const STRING_TYPE = 0x2b
/** The version and type bytes between the class name and the `+` stay within this. */
const MARKER_WINDOW = 8
/** Messages puts U+FFFC where an attachment sits in the text. */
const OBJECT_REPLACEMENT = /￼/gu

export const attributedBodyText = (blob: Uint8Array | null | undefined): string | null => {
  if (!blob || blob.byteLength === 0) return null
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  const name = bytes.indexOf(NSSTRING)
  if (name < 0) return null
  const afterName = name + NSSTRING.length
  const marker = bytes.indexOf(STRING_TYPE, afterName)
  if (marker < 0 || marker - afterName > MARKER_WINDOW) return null
  const length = readLength(bytes, marker + 1)
  if (!length) return null
  const end = length.start + length.value
  if (length.value === 0 || end > bytes.length) return null
  return bytes.subarray(length.start, end).toString('utf8')
}

const readLength = (bytes: Buffer, at: number): { start: number; value: number } | null => {
  if (at >= bytes.length) return null
  const first = bytes[at]!
  if (first < 0x80) return { start: at + 1, value: first }
  if (first === 0x81 && at + 3 <= bytes.length) return { start: at + 3, value: bytes.readUInt16LE(at + 1) }
  if (first === 0x82 && at + 5 <= bytes.length) return { start: at + 5, value: bytes.readUInt32LE(at + 1) }
  return null
}

/** Message text as a person would read it: attachment markers removed, outer whitespace trimmed. */
export const readableMessageText = (text: string | null, body: Uint8Array | null | undefined): string =>
  (text && text.length > 0 ? text : attributedBodyText(body) ?? '').replace(OBJECT_REPLACEMENT, '').trim()
