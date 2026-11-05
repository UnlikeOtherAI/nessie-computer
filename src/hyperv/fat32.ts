import { WorkspacePathError } from '../workspace-paths.js'
import {
  fat32DirectoryEntry,
  fat32DotEntries,
  fat32LongNameEntries,
  fat32ShortName,
  fat32ShortNameChecksum,
  fat32VolumeLabelEntry,
  ATTR_ARCHIVE,
  ATTR_DIRECTORY,
  DIRECTORY_ENTRY_BYTES,
  LONG_NAME_CHARS_PER_ENTRY,
} from './fat32-names.js'

/**
 * A FAT32 volume writer, enough for a boot disk and no more.
 *
 * Every constant, offset and formula below is transcribed from Microsoft's
 * *FAT Specification* (published as `fatgen103`, "Microsoft Extensible Firmware
 * Initiative FAT32 File System Specification", version 1.03, © 2004 Microsoft
 * Corporation); the section numbers in the comments are that document's, and
 * the field names are its own (`BPB_*`, `BS_*`, `FSI_*`).
 *
 * The image is a **whole-disk volume with no partition table**: sector 0 is the
 * BPB itself, which is why `BPB_HiddSec` is 0 — §3.1 requires that field to be
 * zero "on media that are not partitioned". The UEFI specification allows this
 * shape ("the file system … shall be on a partition or on the whole disk"), and
 * it is the shape this boot disk has always had, so the firmware sees the same
 * volume it always did.
 *
 * Output is **deterministic**: fixed timestamps (`fat32-names.ts`), a fixed
 * volume serial, contiguous allocation in tree order, and zeroed slack. Two
 * builds of the same tree hash the same, which is what lets a release compare a
 * boot disk it built against one built anywhere else.
 */

export const FAT32_SECTOR_BYTES = 512
const FAT_ENTRY_BYTES = 4
const FAT_COUNT = 2
/** §3.2 requires 32 reserved sectors for FAT32; the table for `BPB_SecPerClus`
 *  is only correct when `BPB_RsvdSecCnt` is 32 and `BPB_NumFATs` is 2. */
const RESERVED_SECTORS = 32
/** §3: the first data cluster is 2 — 0 and 1 are the reserved FAT entries. */
const FIRST_DATA_CLUSTER = 2
/** §4.2: `FAT[0]` is the media byte with every other bit set; `FAT[1]` is EOC
 *  with both "clean shutdown" and "no hard error" flags left set. */
const FAT_ENTRY_MEDIA = 0x0fff_fff8
const FAT_ENTRY_END_OF_CHAIN = 0x0fff_ffff
/** §3.1: 0xF8 is "the standard value for fixed (non-removable) media". */
const MEDIA_FIXED = 0xf8

/**
 * §3.5: `CountofClusters < 65525` **is** a FAT16 volume, and the specification
 * additionally recommends never sitting exactly on that boundary, so the writer
 * requires strictly more. The FAT itself holds `CountofClusters + 2` entries,
 * the two extra being `FAT[0]` and `FAT[1]`.
 */
export const FAT32_MINIMUM_CLUSTER_COUNT = 65_525

/**
 * §3.5, `DskTableFAT32`: the specification's own disk-size-to-cluster-size
 * table, in sectors. The first matching row wins. Its first row is the reason a
 * FAT32 volume cannot be small — under 32.5 MB there is no cluster size that
 * clears the 65,525 floor, and the specification's `0` there "trips an error".
 */
const SECTORS_PER_CLUSTER_TABLE: ReadonlyArray<{ maxSectors: number; sectorsPerCluster: number }> = [
  { maxSectors: 66_600, sectorsPerCluster: 0 },
  { maxSectors: 532_480, sectorsPerCluster: 1 },
  { maxSectors: 16_777_216, sectorsPerCluster: 8 },
  { maxSectors: 33_554_432, sectorsPerCluster: 16 },
  { maxSectors: 67_108_864, sectorsPerCluster: 32 },
  { maxSectors: Number.MAX_SAFE_INTEGER, sectorsPerCluster: 64 },
]

export type Fat32Geometry = {
  clusterCount: number
  fatSectors: number
  firstDataSector: number
  reservedSectors: number
  sectorsPerCluster: number
  totalSectors: number
}

/**
 * §3.5's `FATSz` derivation, transcribed. Its own note says the arithmetic "will
 * occasionally set a FATSz that is up to 8 sectors too large for FAT32 … It will
 * never compute a FATSz value that is too small", and a FAT with slack is
 * correct, so it is used as published rather than tightened.
 */
export const fat32Geometry = (sizeBytes: number): Fat32Geometry => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes % FAT32_SECTOR_BYTES !== 0) {
    throw new WorkspacePathError('A guest boot disk must be a whole number of 512-byte sectors.')
  }
  const totalSectors = sizeBytes / FAT32_SECTOR_BYTES
  const row = SECTORS_PER_CLUSTER_TABLE.find((entry) => totalSectors <= entry.maxSectors)!
  const sectorsPerCluster = row.sectorsPerCluster
  if (sectorsPerCluster === 0) {
    throw new WorkspacePathError('A guest boot disk is too small to hold a FAT32 volume.')
  }
  // §3.5: RootDirSectors is 0 on FAT32, so it drops out of both formulas.
  const perFatDivisor = Math.floor(((256 * sectorsPerCluster) + FAT_COUNT) / 2)
  const fatSectors = Math.ceil((totalSectors - RESERVED_SECTORS) / perFatDivisor)
  const firstDataSector = RESERVED_SECTORS + (FAT_COUNT * fatSectors)
  const clusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster)
  if (clusterCount <= FAT32_MINIMUM_CLUSTER_COUNT) {
    throw new WorkspacePathError('A guest boot disk is too small to hold a FAT32 volume.')
  }
  return {
    clusterCount,
    fatSectors,
    firstDataSector,
    reservedSectors: RESERVED_SECTORS,
    sectorsPerCluster,
    totalSectors,
  }
}

export type Fat32Node =
  | { content: Uint8Array; kind: 'file'; name: string }
  | { children: readonly Fat32Node[]; kind: 'directory'; name: string }

/** One object's contiguous cluster run, plus the bytes that go in it. */
type Allocation = { bytes: Uint8Array; firstCluster: number; clusterCount: number }

const clusterBytes = (geometry: Fat32Geometry): number =>
  geometry.sectorsPerCluster * FAT32_SECTOR_BYTES

/**
 * §6: a name occupies one short entry preceded by its long entries, and a
 * directory is a whole number of clusters whose unused entries are zero (a
 * `DIR_Name[0]` of 0x00 means "free, and no allocated entry follows").
 */
const nameEntries = (node: Fat32Node, firstCluster: number): Buffer => {
  const short = fat32ShortName(node.name)
  const entry = fat32DirectoryEntry({
    attributes: node.kind === 'directory' ? ATTR_DIRECTORY : ATTR_ARCHIVE,
    firstCluster,
    shortNameBytes: short.bytes,
    sizeBytes: node.kind === 'file' ? node.content.byteLength : 0,
  })
  if (short.exact) return entry
  return Buffer.concat([fat32LongNameEntries(node.name, fat32ShortNameChecksum(short.bytes)), entry])
}

/** How many 32-byte slots a directory needs: its leading entries — the volume
 *  label for the root, `.` and `..` for every other — plus each child's short
 *  entry and however many long entries its name spills into. */
const directoryEntryCount = (children: readonly Fat32Node[], leadingEntries: number): number =>
  children.reduce(
    (total, child) => total + (fat32ShortName(child.name).exact
      ? 1
      : 1 + Math.ceil([...child.name].length / LONG_NAME_CHARS_PER_ENTRY)),
    leadingEntries,
  )

const clustersFor = (byteLength: number, geometry: Fat32Geometry): number =>
  Math.ceil(byteLength / clusterBytes(geometry))

/** A directory occupies whole clusters, and its size is fixed by its children's
 *  *names* alone — which is what lets one walk both claim and fill. */
const directorySizeBytes = (
  children: readonly Fat32Node[],
  leadingEntries: number,
  geometry: Fat32Geometry,
): number => clustersFor(
  directoryEntryCount(children, leadingEntries) * DIRECTORY_ENTRY_BYTES,
  geometry,
) * clusterBytes(geometry)

const nodeSizeBytes = (node: Fat32Node, geometry: Fat32Geometry): number =>
  node.kind === 'file' ? node.content.byteLength : directorySizeBytes(node.children, 2, geometry)

/**
 * Walks the tree once, assigning each object a contiguous run of clusters and
 * filling the parent's entry in as it goes. Nothing is fragmented because
 * nothing is ever deleted, so every run is its own chain, and the two passes a
 * real allocator needs collapse into one: a directory's size is knowable before
 * any of its children have clusters.
 */
const allocateTree = (input: {
  geometry: Fat32Geometry
  label: string
  root: readonly Fat32Node[]
}): Allocation[] => {
  const { geometry } = input
  const allocations: Allocation[] = []
  let nextCluster = FIRST_DATA_CLUSTER

  const claim = (byteLength: number): number => {
    const firstCluster = nextCluster
    nextCluster += clustersFor(byteLength, geometry)
    return firstCluster
  }

  let rootCluster = FIRST_DATA_CLUSTER

  const place = (children: readonly Fat32Node[], firstCluster: number, leading: Buffer): void => {
    const leadingEntries = leading.byteLength / DIRECTORY_ENTRY_BYTES
    const bytes = Buffer.alloc(directorySizeBytes(children, leadingEntries, geometry))
    leading.copy(bytes, 0)
    let offset = leading.byteLength
    const placed: Array<{ firstCluster: number; node: Fat32Node }> = []
    for (const child of children) {
      const childBytes = nodeSizeBytes(child, geometry)
      // §6.1: a zero-length file owns no cluster, so its entry names cluster 0.
      const childCluster = childBytes === 0 ? 0 : claim(childBytes)
      offset += nameEntries(child, childCluster).copy(bytes, offset)
      placed.push({ firstCluster: childCluster, node: child })
    }
    allocations.push({ bytes, clusterCount: clustersFor(bytes.byteLength, geometry), firstCluster })
    for (const { firstCluster: childCluster, node } of placed) {
      if (node.kind === 'directory') {
        // §6.1: `..` names cluster 0 when the parent *is* the root directory,
        // never the root's real cluster — fsck.fat calls the latter an
        // "Invalid '..' entry in the second slot".
        const parentCluster = firstCluster === rootCluster ? 0 : firstCluster
        place(node.children, childCluster, fat32DotEntries(childCluster, parentCluster))
      } else if (childCluster !== 0) {
        allocations.push({
          bytes: node.content,
          clusterCount: clustersFor(node.content.byteLength, geometry),
          firstCluster: childCluster,
        })
      }
    }
  }

  // §3.1: `BPB_RootClus` is the root directory's first cluster, and 2 is "the
  // typical, and recommended, value". The root has no `.`/`..`; the volume
  // label entry sits in their place.
  rootCluster = claim(directorySizeBytes(input.root, 1, geometry))
  place(input.root, rootCluster, fat32VolumeLabelEntry(input.label))
  return allocations
}

/** §4: one FAT, with the two reserved entries and one chain per allocation. */
const buildFat = (allocations: readonly Allocation[], geometry: Fat32Geometry): Buffer => {
  const fat = Buffer.alloc(geometry.fatSectors * FAT32_SECTOR_BYTES)
  fat.writeUInt32LE(FAT_ENTRY_MEDIA, 0)
  fat.writeUInt32LE(FAT_ENTRY_END_OF_CHAIN, FAT_ENTRY_BYTES)
  for (const allocation of allocations) {
    for (let index = 0; index < allocation.clusterCount; index += 1) {
      const cluster = allocation.firstCluster + index
      const next = index === allocation.clusterCount - 1
        ? FAT_ENTRY_END_OF_CHAIN
        : cluster + 1
      fat.writeUInt32LE(next, cluster * FAT_ENTRY_BYTES)
    }
  }
  return fat
}

/** §5: the FSInfo sector, whose three signatures are what makes it readable. */
const buildFsInfo = (input: { freeClusters: number; nextFreeCluster: number }): Buffer => {
  const sector = Buffer.alloc(FAT32_SECTOR_BYTES)
  sector.writeUInt32LE(0x4161_5252, 0)
  sector.writeUInt32LE(0x6141_7272, 484)
  sector.writeUInt32LE(input.freeClusters, 488)
  sector.writeUInt32LE(input.nextFreeCluster, 492)
  sector.writeUInt32LE(0xaa55_0000, 508)
  return sector
}

/**
 * A fixed serial. §3.1 calls `BS_VolID` "a serial number … generated by
 * combining the current date and time", which is exactly the non-determinism a
 * reproducible image cannot have; nothing reads it here, and the volume is
 * identified by its label.
 */
const VOLUME_SERIAL = 0x4e45_5353

/** §3.6: "On FAT32 formatted volumes, sector #6 must contain a copy of the
 *  BPB", and a copy of the FSInfo sector sits beside it. */
const BACKUP_BOOT_SECTOR = 6

/** §3.1 and §3.2: sector 0, and the copy of it §3.6 requires at sector 6. */
const buildBootSector = (input: { geometry: Fat32Geometry; label: string }): Buffer => {
  const sector = Buffer.alloc(FAT32_SECTOR_BYTES)
  // §3.1: `BS_jmpBoot` must be a real jump even on a volume nothing boots from
  // by executing sector 0; 0xEB 0x58 0x90 is the specification's own FAT32 form.
  sector.set([0xeb, 0x58, 0x90], 0)
  sector.write('NESSIE  ', 3, 8, 'ascii')
  sector.writeUInt16LE(FAT32_SECTOR_BYTES, 11)
  sector.writeUInt8(input.geometry.sectorsPerCluster, 13)
  sector.writeUInt16LE(input.geometry.reservedSectors, 14)
  sector.writeUInt8(FAT_COUNT, 16)
  // `BPB_RootEntCnt` and `BPB_TotSec16` are 0 on FAT32; `BPB_FATSz16` too.
  sector.writeUInt8(MEDIA_FIXED, 21)
  // §3.1: geometry fields are "only relevant for media that have a geometry";
  // this is a file, so the conventional values are written and read by nobody.
  sector.writeUInt16LE(63, 24)
  sector.writeUInt16LE(255, 26)
  // `BPB_HiddSec` stays 0: the volume is the whole disk, not a partition.
  sector.writeUInt32LE(input.geometry.totalSectors, 32)
  sector.writeUInt32LE(input.geometry.fatSectors, 36)
  // `BPB_ExtFlags` 0 = the FAT is mirrored into all FATs; `BPB_FSVer` 0.
  sector.writeUInt32LE(FIRST_DATA_CLUSTER, 44)
  sector.writeUInt16LE(1, 48)
  sector.writeUInt16LE(BACKUP_BOOT_SECTOR, 50)
  sector.writeUInt8(0x80, 64)
  sector.writeUInt8(0x29, 66)
  sector.writeUInt32LE(VOLUME_SERIAL, 67)
  sector.write(input.label.padEnd(11, ' '), 71, 11, 'ascii')
  sector.write('FAT32   ', 82, 8, 'ascii')
  sector.writeUInt16LE(0xaa55, 510)
  return sector
}

export type Fat32ImageInput = {
  label: string
  root: readonly Fat32Node[]
  sizeBytes: number
}

/**
 * Builds the whole volume in memory. A boot disk is a kernel and an initrd —
 * tens of megabytes — and the slack is zero-filled by the allocation itself, so
 * there is nothing a streaming writer would buy beyond a second code path that
 * could disagree with this one about where a cluster starts.
 */
export const buildFat32Image = (input: Fat32ImageInput): Buffer => {
  const geometry = fat32Geometry(input.sizeBytes)
  const allocations = allocateTree({ geometry, label: input.label, root: input.root })
  const used = allocations.reduce((total, allocation) => total + allocation.clusterCount, 0)
  if (used > geometry.clusterCount) {
    throw new WorkspacePathError('The executor guest kernel and initrd do not fit on the boot disk.')
  }
  const image = Buffer.alloc(input.sizeBytes)
  const boot = buildBootSector({ geometry, label: input.label })
  const fsInfo = buildFsInfo({
    freeClusters: geometry.clusterCount - used,
    nextFreeCluster: FIRST_DATA_CLUSTER + used,
  })
  boot.copy(image, 0)
  fsInfo.copy(image, FAT32_SECTOR_BYTES)
  boot.copy(image, BACKUP_BOOT_SECTOR * FAT32_SECTOR_BYTES)
  fsInfo.copy(image, (BACKUP_BOOT_SECTOR + 1) * FAT32_SECTOR_BYTES)
  const fat = buildFat(allocations, geometry)
  for (let copy = 0; copy < FAT_COUNT; copy += 1) {
    fat.copy(image, (geometry.reservedSectors + (copy * geometry.fatSectors)) * FAT32_SECTOR_BYTES)
  }
  for (const allocation of allocations) {
    const sector = geometry.firstDataSector
      + ((allocation.firstCluster - FIRST_DATA_CLUSTER) * geometry.sectorsPerCluster)
    image.set(allocation.bytes, sector * FAT32_SECTOR_BYTES)
  }
  return image
}
