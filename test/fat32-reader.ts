/**
 * A FAT32 *reader*, written against Microsoft's FAT Specification and used only
 * by the tests. It is deliberately an independent implementation of the same
 * document as `src/hyperv/fat32.ts` — it re-derives every offset from the BPB
 * on disk rather than importing a constant from the writer, so an agreement
 * between the two is evidence about the format and not a restatement.
 */

export type Fat32Volume = {
  bytesPerCluster: number
  clusterCount: number
  fatSectors: number
  firstDataSector: number
  label: string
  rootCluster: number
  sectorsPerCluster: number
  totalSectors: number
}

export type Fat32Entry = {
  attributes: number
  firstCluster: number
  longName: string
  shortName: string
  sizeBytes: number
}

const u16 = (image: Buffer, offset: number): number => image.readUInt16LE(offset)
const u32 = (image: Buffer, offset: number): number => image.readUInt32LE(offset)

export const readFat32Volume = (image: Buffer): Fat32Volume => {
  if (u16(image, 510) !== 0xaa55) throw new Error('no boot signature')
  const bytesPerSector = u16(image, 11)
  const sectorsPerCluster = image.readUInt8(13)
  const reservedSectors = u16(image, 14)
  const fatCount = image.readUInt8(16)
  const fatSectors = u32(image, 36)
  const totalSectors = u32(image, 32)
  const firstDataSector = reservedSectors + (fatCount * fatSectors)
  return {
    bytesPerCluster: bytesPerSector * sectorsPerCluster,
    // §3.5, verbatim: RootDirSectors is 0 on FAT32, so DataSec is what is left.
    clusterCount: Math.floor((totalSectors - firstDataSector) / sectorsPerCluster),
    fatSectors,
    firstDataSector: firstDataSector * bytesPerSector,
    label: image.toString('ascii', 71, 82).trimEnd(),
    rootCluster: u32(image, 44),
    sectorsPerCluster,
    totalSectors,
  }
}

/** §4: follows one cluster chain to its end-of-chain marker. */
export const readChain = (image: Buffer, volume: Fat32Volume, first: number): Buffer => {
  const bytesPerSector = u16(image, 11)
  const fatOffset = u16(image, 14) * bytesPerSector
  const parts: Buffer[] = []
  const seen = new Set<number>()
  for (let cluster = first; cluster >= 2 && cluster < 0x0fff_fff8;) {
    if (seen.has(cluster)) throw new Error('cluster chain loops')
    seen.add(cluster)
    const start = volume.firstDataSector + ((cluster - 2) * volume.bytesPerCluster)
    parts.push(image.subarray(start, start + volume.bytesPerCluster))
    cluster = u32(image, fatOffset + (cluster * 4)) & 0x0fff_ffff
  }
  return Buffer.concat(parts)
}

const LONG_NAME_SLOTS: ReadonlyArray<{ count: number; offset: number }> = [
  { count: 5, offset: 1 },
  { count: 6, offset: 14 },
  { count: 2, offset: 28 },
]

const longNameFragment = (entry: Buffer): string => {
  let text = ''
  for (const slot of LONG_NAME_SLOTS) {
    for (let index = 0; index < slot.count; index += 1) {
      const code = entry.readUInt16LE(slot.offset + (index * 2))
      if (code === 0 || code === 0xffff) return text
      text += String.fromCharCode(code)
    }
  }
  return text
}

/** §7's checksum, re-derived here so the reader can reject a mismatched set. */
const shortNameChecksum = (name: Buffer): number => {
  let sum = 0
  for (const byte of name) sum = (((sum & 1) ? 0x80 : 0) + (sum >> 1) + byte) & 0xff
  return sum
}

/** §6: reads one directory, joining each long-entry run to the short entry it
 *  precedes and refusing a run whose checksum does not bind to it. */
export const readDirectory = (directory: Buffer): Fat32Entry[] => {
  const entries: Fat32Entry[] = []
  let pending: Array<{ ordinal: number; text: string }> = []
  let pendingChecksum: number | undefined
  for (let offset = 0; offset + 32 <= directory.byteLength; offset += 32) {
    const entry = directory.subarray(offset, offset + 32)
    const first = entry.readUInt8(0)
    if (first === 0x00) break
    if (first === 0xe5) { pending = []; continue }
    const attributes = entry.readUInt8(11)
    if (attributes === 0x0f) {
      pending.push({ ordinal: first & 0x3f, text: longNameFragment(entry) })
      pendingChecksum = entry.readUInt8(13)
      continue
    }
    const shortNameBytes = entry.subarray(0, 11)
    if (pending.length > 0 && pendingChecksum !== shortNameChecksum(shortNameBytes)) {
      throw new Error('long name checksum does not bind to its short entry')
    }
    const base = shortNameBytes.toString('ascii', 0, 8).trimEnd()
    const extension = shortNameBytes.toString('ascii', 8, 11).trimEnd()
    entries.push({
      attributes,
      firstCluster: (u16(entry, 20) << 16) | u16(entry, 26),
      longName: [...pending]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((part) => part.text)
        .join(''),
      shortName: extension ? `${base}.${extension}` : base,
      sizeBytes: u32(entry, 28),
    })
    pending = []
    pendingChecksum = undefined
  }
  return entries
}

/** Resolves a `/`-separated path to its bytes, walking directory by directory. */
export const readFat32File = (image: Buffer, path: string): Buffer => {
  const volume = readFat32Volume(image)
  const segments = path.split('/')
  let cluster = volume.rootCluster
  for (const [index, segment] of segments.entries()) {
    const entry = readDirectory(readChain(image, volume, cluster))
      .find((candidate) => candidate.longName === segment || candidate.shortName === segment)
    if (!entry) throw new Error(`no entry named ${segment}`)
    if (index === segments.length - 1) {
      return readChain(image, volume, entry.firstCluster).subarray(0, entry.sizeBytes)
    }
    cluster = entry.firstCluster
  }
  throw new Error('empty path')
}

export const readFat32Directory = (image: Buffer, path: string): Fat32Entry[] => {
  const volume = readFat32Volume(image)
  let cluster = volume.rootCluster
  for (const segment of path.split('/').filter(Boolean)) {
    const entry = readDirectory(readChain(image, volume, cluster))
      .find((candidate) => candidate.longName === segment || candidate.shortName === segment)
    if (!entry) throw new Error(`no entry named ${segment}`)
    cluster = entry.firstCluster
  }
  return readDirectory(readChain(image, volume, cluster))
}
