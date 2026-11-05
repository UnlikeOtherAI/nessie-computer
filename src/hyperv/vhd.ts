import { randomUUID } from 'node:crypto'
import { appendFile, rename, stat } from 'node:fs/promises'

import { WorkspacePathError } from '../workspace-paths.js'

/**
 * A raw disk image becomes a **fixed VHD** by appending one 512-byte footer to
 * it, and nothing else: a fixed VHD is defined as the raw payload followed by
 * that footer. Nothing here needs a privilege, a loop device, or a Hyper-V
 * cmdlet, which is what lets the daemon build a session's disks as an ordinary
 * account on a machine where it is not an administrator.
 *
 * Every field below is from Microsoft's *Virtual Hard Disk Image Format
 * Specification* (version 1.0, October 2006), "Hard Disk Footer Format".
 *
 * **Why VHD and not VHDX.** Hyper-V generation 2 refuses VHD outright — "Can I
 * attach a virtual hard disk in VHD format to a generation 2 virtual machine?
 * No. Generation 2 virtual machines only support VHDX format virtual hard
 * drives" (Generation 2 Virtual Machine Overview) — so the create script runs
 * `Convert-VHD` on each of these, which needs a *virtual* hard disk as its
 * input and would refuse a bare ext4 image. The footer is what turns the image
 * into something `Convert-VHD` will read. See `create.ps1`.
 */
const FOOTER_BYTES = 512
const SECTOR_BYTES = 512
const COOKIE = 'conectix'
/** Bit 1 ("reserved") is documented as always set; bit 0 is "temporary". */
const FEATURES = 0x0000_0002
const FILE_FORMAT_VERSION = 0x0001_0000
/** A fixed disk has no dynamic header, so the offset is the documented ~0. */
const DATA_OFFSET = 0xffff_ffff_ffff_ffffn
const CREATOR_APPLICATION = 'nsse'
const CREATOR_VERSION = 0x0001_0000
/** "Wi2k" — the documented Windows value; the disks are only read by Hyper-V. */
const CREATOR_HOST_OS = 0x5769_326b
const DISK_TYPE_FIXED = 2
/** The VHD epoch is 2000-01-01T00:00:00Z, not the Unix one. */
const VHD_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0, 0)

export type VhdGeometry = { cylinders: number; heads: number; sectorsPerTrack: number }

/**
 * The specification's own CHS derivation, transcribed. It is not a description
 * of any real geometry — a 64 TiB disk has no cylinders — but the values are
 * validated on read, so they are computed exactly as published rather than
 * invented.
 */
export const vhdGeometry = (totalSectorsInput: number): VhdGeometry => {
  const maximum = 65_535 * 16 * 255
  const totalSectors = Math.min(totalSectorsInput, maximum)
  let sectorsPerTrack: number
  let heads: number
  let cylinderTimesHeads: number
  if (totalSectors >= 65_535 * 16 * 63) {
    sectorsPerTrack = 255
    heads = 16
    cylinderTimesHeads = Math.floor(totalSectors / sectorsPerTrack)
  } else {
    sectorsPerTrack = 17
    cylinderTimesHeads = Math.floor(totalSectors / sectorsPerTrack)
    heads = Math.floor((cylinderTimesHeads + 1023) / 1024)
    if (heads < 4) heads = 4
    if (cylinderTimesHeads >= heads * 1024 || heads > 16) {
      sectorsPerTrack = 31
      heads = 16
      cylinderTimesHeads = Math.floor(totalSectors / sectorsPerTrack)
    }
    if (cylinderTimesHeads >= heads * 1024) {
      sectorsPerTrack = 63
      heads = 16
      cylinderTimesHeads = Math.floor(totalSectors / sectorsPerTrack)
    }
  }
  return { cylinders: Math.floor(cylinderTimesHeads / heads), heads, sectorsPerTrack }
}

/**
 * "The checksum field ... is a one's complement of the sum of all the bytes in
 * the footer without the checksum field." Summing bytes of a 512-byte structure
 * cannot overflow 32 bits, so the mask is only there to make the width explicit.
 */
export const vhdFooterChecksum = (footer: Buffer): number => {
  let sum = 0
  for (let index = 0; index < footer.byteLength; index += 1) {
    if (index >= 64 && index < 68) continue
    sum += footer[index] as number
  }
  return (~sum >>> 0)
}

export type VhdFooterInput = {
  /** The raw payload size in bytes; must be a whole number of 512-byte sectors. */
  sizeBytes: number
  /** Milliseconds since the Unix epoch; injected so a build is reproducible. */
  timestampMs?: number
  /** RFC 4122 UUID string; injected for the same reason. */
  uniqueId?: string
}

export const buildFixedVhdFooter = (input: VhdFooterInput): Buffer => {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new WorkspacePathError('A guest disk image has no readable size.')
  }
  if (input.sizeBytes % SECTOR_BYTES !== 0) {
    throw new WorkspacePathError('A guest disk image must be a whole number of 512-byte sectors.')
  }
  const footer = Buffer.alloc(FOOTER_BYTES)
  footer.write(COOKIE, 0, 'ascii')
  footer.writeUInt32BE(FEATURES, 8)
  footer.writeUInt32BE(FILE_FORMAT_VERSION, 12)
  footer.writeBigUInt64BE(DATA_OFFSET, 16)
  const seconds = Math.floor(((input.timestampMs ?? Date.now()) - VHD_EPOCH_MS) / 1000)
  footer.writeUInt32BE(Math.max(0, seconds) >>> 0, 24)
  footer.write(CREATOR_APPLICATION, 28, 'ascii')
  footer.writeUInt32BE(CREATOR_VERSION, 32)
  footer.writeUInt32BE(CREATOR_HOST_OS, 36)
  footer.writeBigUInt64BE(BigInt(input.sizeBytes), 40)
  footer.writeBigUInt64BE(BigInt(input.sizeBytes), 48)
  const geometry = vhdGeometry(input.sizeBytes / SECTOR_BYTES)
  footer.writeUInt16BE(geometry.cylinders, 56)
  footer.writeUInt8(geometry.heads, 58)
  footer.writeUInt8(geometry.sectorsPerTrack, 59)
  footer.writeUInt32BE(DISK_TYPE_FIXED, 60)
  const uniqueId = Buffer.from((input.uniqueId ?? randomUUID()).replace(/-/g, ''), 'hex')
  if (uniqueId.byteLength !== 16) {
    throw new WorkspacePathError('A guest disk image identifier is malformed.')
  }
  uniqueId.copy(footer, 68)
  // Saved State stays 0 and the 427 reserved bytes stay zero, both documented.
  footer.writeUInt32BE(vhdFooterChecksum(footer), 64)
  return footer
}

export type VhdWrapDependencies = {
  timestampMs?: number
  uniqueId?: () => string
}

/**
 * Turns one raw image into a fixed VHD **in place**: the payload is already the
 * whole of a fixed VHD but its footer, so the file is renamed and the footer
 * appended rather than copied. A session's images are hundreds of megabytes and
 * a copy would double both the time and the disk a sandbox costs.
 */
export const wrapImageAsFixedVhd = async (
  rawPath: string,
  vhdPath: string,
  dependencies: VhdWrapDependencies = {},
): Promise<string> => {
  const info = await stat(rawPath).catch(() => undefined)
  if (!info?.isFile()) {
    throw new WorkspacePathError('A guest disk image is missing before it could be attached.')
  }
  await rename(rawPath, vhdPath)
  await appendFile(vhdPath, buildFixedVhdFooter({
    sizeBytes: info.size,
    ...(dependencies.timestampMs === undefined ? {} : { timestampMs: dependencies.timestampMs }),
    ...(dependencies.uniqueId === undefined ? {} : { uniqueId: dependencies.uniqueId() }),
  }))
  return vhdPath
}
