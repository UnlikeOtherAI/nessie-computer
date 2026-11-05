import { WorkspacePathError } from '../workspace-paths.js'

/**
 * Names and 32-byte directory entries for the FAT32 writer beside this file.
 *
 * Every field offset, constant and algorithm below is transcribed from
 * Microsoft's *FAT Specification* (the document published as `fatgen103`,
 * "Microsoft Extensible Firmware Initiative FAT32 File System Specification",
 * version 1.03, © 2004 Microsoft Corporation), section 6 ("FAT Directory
 * Structure") and section 7 ("Long File Name Implementation"). The section
 * numbers in the comments are that document's.
 */

/** §6: a directory entry is 32 bytes, and a directory is a run of them. */
export const DIRECTORY_ENTRY_BYTES = 32

/** §6, "Directory Entry Attributes". Only the four this writer emits. */
export const ATTR_VOLUME_ID = 0x08
export const ATTR_DIRECTORY = 0x10
export const ATTR_ARCHIVE = 0x20
/** §7: an entry whose attribute byte is exactly this is a long-name entry. */
export const ATTR_LONG_NAME = 0x0f

/** §7: `LAST_LONG_ENTRY`, OR'd into the ordinal of the final long entry. */
const LAST_LONG_ENTRY = 0x40
/** §7: each long entry carries 13 UCS-2 characters, in three runs. */
export const LONG_NAME_CHARS_PER_ENTRY = 13
const LONG_NAME_SLOTS: ReadonlyArray<{ count: number; offset: number }> = [
  { count: 5, offset: 1 },
  { count: 6, offset: 14 },
  { count: 2, offset: 28 },
]
/** §7: a long name is at most 255 characters. */
const LONG_NAME_MAX_CHARS = 255
/** §7: the slot after the name holds NUL, and the rest hold 0xFFFF. */
const LONG_NAME_PAD = 0xffff

const SHORT_BASE_BYTES = 8
const SHORT_EXTENSION_BYTES = 3
const SHORT_NAME_BYTES = SHORT_BASE_BYTES + SHORT_EXTENSION_BYTES

/**
 * The FAT epoch is 1980-01-01, and a date word is `(year - 1980) << 9 | month
 * << 5 | day` (§6, `DIR_CrtDate`). Every timestamp this writer stamps is that
 * epoch with a zero time, so two builds of the same tree are byte-identical —
 * there is nothing in a boot disk a modification time answers a question about.
 */
export const FAT_EPOCH_DATE = (0 << 9) | (1 << 5) | 1
export const FAT_EPOCH_TIME = 0

/**
 * Deliberately narrower than FAT allows. The writer's callers name their own
 * files, so an unencodable name is a mistake to refuse rather than a name to
 * mangle: silently rewriting `BOOTX64.EFI` into something else would leave a
 * disk the firmware cannot boot and no error saying why.
 */
const ENCODABLE_NAME = /^[A-Za-z0-9_~-]{1,32}(\.[A-Za-z0-9_~-]{1,3})?$/

export type ShortName = {
  /** The 11 bytes stored in `DIR_Name`: base padded to 8, extension to 3. */
  bytes: Buffer
  /** True when the 8.3 form spells the requested name exactly, so no long
   *  entry is needed — `BOOTX64.EFI` is already its own short name. */
  exact: boolean
}

const shortNameField = (base: string, extension: string): Buffer => {
  const bytes = Buffer.alloc(SHORT_NAME_BYTES, 0x20)
  bytes.write(base, 0, SHORT_BASE_BYTES, 'ascii')
  bytes.write(extension, SHORT_BASE_BYTES, SHORT_EXTENSION_BYTES, 'ascii')
  return bytes
}

/**
 * §6.1: `DIR_Name` is uppercase 8.3 with no dot stored. A name that does not
 * survive that conversion keeps the first six characters of its base plus the
 * `~1` numeric tail the specification's own worked example uses (`THEQUI~1FOX`
 * for "The quick brown fox"), and the requested spelling is preserved in the
 * long entries that precede it.
 */
export const fat32ShortName = (name: string): ShortName => {
  if (!ENCODABLE_NAME.test(name)) {
    throw new WorkspacePathError('A guest boot disk file name cannot be stored on FAT32.')
  }
  const dot = name.lastIndexOf('.')
  const base = (dot === -1 ? name : name.slice(0, dot)).toUpperCase()
  const extension = (dot === -1 ? '' : name.slice(dot + 1)).toUpperCase()
  if (base.length <= SHORT_BASE_BYTES && `${base}${extension && '.'}${extension}` === name) {
    return { bytes: shortNameField(base, extension), exact: true }
  }
  return { bytes: shortNameField(`${base.slice(0, 6)}~1`, extension), exact: false }
}

/**
 * §7, `ChkSum()`: "an unsigned char rotate right" folded over the 11 short-name
 * bytes. It is what binds a long-entry set to the short entry that follows it,
 * so a reader that ignores long names still sees a consistent directory.
 */
export const fat32ShortNameChecksum = (shortNameBytes: Buffer): number => {
  if (shortNameBytes.byteLength !== SHORT_NAME_BYTES) {
    throw new WorkspacePathError('A guest boot disk short name is malformed.')
  }
  let sum = 0
  for (const byte of shortNameBytes) {
    sum = ((((sum & 1) ? 0x80 : 0) + (sum >> 1) + byte) & 0xff)
  }
  return sum
}

/**
 * §7: the long entries for one name, in the order they are written — the set is
 * stored **backwards**, so the entry carrying the tail of the name comes first
 * and the one bearing `LAST_LONG_ENTRY` is at the top of the run. Immediately
 * after the run comes the short entry the checksum was taken from.
 */
export const fat32LongNameEntries = (name: string, checksum: number): Buffer => {
  const characters = [...name]
  if (characters.length > LONG_NAME_MAX_CHARS || characters.some((c) => c.codePointAt(0)! > 0xffff)) {
    throw new WorkspacePathError('A guest boot disk file name cannot be stored on FAT32.')
  }
  const count = Math.ceil(characters.length / LONG_NAME_CHARS_PER_ENTRY)
  const entries = Buffer.alloc(count * DIRECTORY_ENTRY_BYTES)
  for (let ordinal = count; ordinal >= 1; ordinal -= 1) {
    const entry = entries.subarray((count - ordinal) * DIRECTORY_ENTRY_BYTES)
    entry.writeUInt8(ordinal === count ? (ordinal | LAST_LONG_ENTRY) : ordinal, 0)
    entry.writeUInt8(ATTR_LONG_NAME, 11)
    // LDIR_Type 0 ("a sub-component of a long name") and LDIR_FstClusLO 0 are
    // the only values §7 permits; both are already zero from the allocation.
    entry.writeUInt8(checksum, 13)
    let character = (ordinal - 1) * LONG_NAME_CHARS_PER_ENTRY
    for (const slot of LONG_NAME_SLOTS) {
      for (let index = 0; index < slot.count; index += 1, character += 1) {
        const code = character < characters.length
          ? characters[character]!.charCodeAt(0)
          : (character === characters.length ? 0 : LONG_NAME_PAD)
        entry.writeUInt16LE(code, slot.offset + index * 2)
      }
    }
  }
  return entries
}

export type DirectoryEntryInput = {
  attributes: number
  firstCluster: number
  shortNameBytes: Buffer
  sizeBytes: number
}

/** §6.1, the 32-byte `DIR_` structure, every reserved field left zero. */
export const fat32DirectoryEntry = (input: DirectoryEntryInput): Buffer => {
  const entry = Buffer.alloc(DIRECTORY_ENTRY_BYTES)
  input.shortNameBytes.copy(entry, 0)
  entry.writeUInt8(input.attributes, 11)
  entry.writeUInt16LE(FAT_EPOCH_TIME, 14)
  entry.writeUInt16LE(FAT_EPOCH_DATE, 16)
  entry.writeUInt16LE(FAT_EPOCH_DATE, 18)
  entry.writeUInt16LE((input.firstCluster >>> 16) & 0xffff, 20)
  entry.writeUInt16LE(FAT_EPOCH_TIME, 22)
  entry.writeUInt16LE(FAT_EPOCH_DATE, 24)
  entry.writeUInt16LE(input.firstCluster & 0xffff, 26)
  entry.writeUInt32LE(input.sizeBytes, 28)
  return entry
}

/**
 * §6.1: a subdirectory's first two entries are `.` and `..`, and a `..` whose
 * parent is the root directory holds cluster **0** rather than the root's real
 * cluster number.
 */
export const fat32DotEntries = (firstCluster: number, parentCluster: number): Buffer => Buffer.concat([
  fat32DirectoryEntry({
    attributes: ATTR_DIRECTORY,
    firstCluster,
    shortNameBytes: shortNameField('.', ''),
    sizeBytes: 0,
  }),
  fat32DirectoryEntry({
    attributes: ATTR_DIRECTORY,
    firstCluster: parentCluster,
    shortNameBytes: shortNameField('..', ''),
    sizeBytes: 0,
  }),
])

/**
 * §6.1: the volume label lives in the root directory as an entry carrying
 * `ATTR_VOLUME_ID`, whose 11 name bytes are the label itself — not a name, so
 * it is neither split at a dot nor given a long entry.
 */
export const fat32VolumeLabelEntry = (label: string): Buffer => {
  if (!/^[A-Z0-9_-]{1,11}$/.test(label)) {
    throw new WorkspacePathError('A guest boot disk volume label is invalid.')
  }
  const bytes = Buffer.alloc(SHORT_NAME_BYTES, 0x20)
  bytes.write(label, 0, SHORT_NAME_BYTES, 'ascii')
  return fat32DirectoryEntry({
    attributes: ATTR_VOLUME_ID,
    firstCluster: 0,
    shortNameBytes: bytes,
    sizeBytes: 0,
  })
}
