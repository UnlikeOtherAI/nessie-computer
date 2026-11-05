import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildFixedVhdFooter,
  vhdFooterChecksum,
  vhdGeometry,
  wrapImageAsFixedVhd,
} from '../src/hyperv/index.js'

const SECTOR = 512
const UNIQUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
/** 2020-06-15T12:00:00Z, comfortably after the VHD epoch. */
const TIMESTAMP_MS = Date.UTC(2020, 5, 15, 12, 0, 0)

const footer = (sizeBytes: number): Buffer =>
  buildFixedVhdFooter({ sizeBytes, timestampMs: TIMESTAMP_MS, uniqueId: UNIQUE_ID })

/**
 * Every field is checked against Microsoft's *Virtual Hard Disk Image Format
 * Specification* "Hard Disk Footer Format" table, because a footer Hyper-V
 * rejects fails at `Convert-VHD` with nothing to attribute it to.
 */
test('a fixed VHD footer states every field the specification requires', () => {
  const image = 16 * 1024 * 1024
  const bytes = footer(image)
  assert.equal(bytes.byteLength, 512)
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'conectix')
  // Features: the "reserved" bit is documented as always set.
  assert.equal(bytes.readUInt32BE(8), 0x0000_0002)
  assert.equal(bytes.readUInt32BE(12), 0x0001_0000)
  // A fixed disk has no dynamic header, so the data offset is ~0.
  assert.equal(bytes.readBigUInt64BE(16), 0xffff_ffff_ffff_ffffn)
  // The VHD epoch is 2000-01-01, not the Unix one.
  assert.equal(bytes.readUInt32BE(24), (TIMESTAMP_MS - Date.UTC(2000, 0, 1)) / 1000)
  assert.equal(bytes.subarray(28, 32).toString('ascii'), 'nsse')
  // "Wi2k", the documented Windows creator host.
  assert.equal(bytes.readUInt32BE(36), 0x5769_326b)
  assert.equal(bytes.readBigUInt64BE(40), BigInt(image))
  assert.equal(bytes.readBigUInt64BE(48), BigInt(image))
  // Disk type 2 is fixed.
  assert.equal(bytes.readUInt32BE(60), 2)
  assert.equal(bytes.subarray(68, 84).toString('hex'), UNIQUE_ID.replace(/-/g, ''))
  assert.equal(bytes.readUInt8(84), 0)
  assert.deepEqual(bytes.subarray(85), Buffer.alloc(427))
})

test('the checksum is the ones complement of the footer with its own field zeroed', () => {
  const bytes = footer(64 * 1024 * 1024)
  const recorded = bytes.readUInt32BE(64)
  const zeroed = Buffer.from(bytes)
  zeroed.writeUInt32BE(0, 64)
  let sum = 0
  for (const byte of zeroed) sum += byte
  assert.equal(recorded, (~sum) >>> 0)
  // And the published rule, applied to the real footer, agrees with it.
  assert.equal(vhdFooterChecksum(bytes), recorded)
})

test('the CHS geometry follows the specification pseudocode at each of its branches', () => {
  // Below 65535*16*63 sectors and small: 17 sectors per track, at least 4 heads.
  assert.deepEqual(vhdGeometry(16 * 1024 * 1024 / SECTOR), {
    cylinders: 481,
    heads: 4,
    sectorsPerTrack: 17,
  })
  // Large enough to take the 255/16 branch, and clamped at the documented
  // maximum of 65535 * 16 * 255 sectors.
  const huge = vhdGeometry(65_535 * 16 * 255 + 1_000_000)
  assert.equal(huge.sectorsPerTrack, 255)
  assert.equal(huge.heads, 16)
  assert.equal(huge.cylinders, 65_535)
  // Every branch must still fit the fields the footer gives them.
  for (const sectors of [4096, 100_000, 8_000_000, 500_000_000]) {
    const geometry = vhdGeometry(sectors)
    assert.ok(geometry.cylinders <= 0xffff && geometry.cylinders > 0)
    assert.ok(geometry.heads <= 0xff && geometry.heads > 0)
    assert.ok(geometry.sectorsPerTrack <= 0xff && geometry.sectorsPerTrack > 0)
  }
})

test('an image that is not a whole number of sectors is refused, never padded', () => {
  // A padded image would be a filesystem with bytes appended to it, and the
  // guest would read the padding as part of the last block.
  assert.throws(() => footer(16 * 1024 * 1024 + 1), /whole number of 512-byte sectors/)
  assert.throws(() => footer(0), /no readable size/)
})

test('wrapping appends the footer in place rather than copying the payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vhd-'))
  const raw = join(directory, 'workspace.img')
  const payload = Buffer.alloc(4 * SECTOR, 0x5a)
  await writeFile(raw, payload)
  const vhd = await wrapImageAsFixedVhd(raw, join(directory, 'workspace.vhd'), {
    timestampMs: TIMESTAMP_MS,
    uniqueId: () => UNIQUE_ID,
  })
  const written = await readFile(vhd)
  assert.equal(written.byteLength, payload.byteLength + 512)
  // A fixed VHD *is* the raw payload followed by the footer, so the bytes the
  // guest mounts must be untouched.
  assert.deepEqual(written.subarray(0, payload.byteLength), payload)
  assert.deepEqual(written.subarray(payload.byteLength), footer(payload.byteLength))
  // The raw image is gone: it was renamed, not copied, so a session never
  // holds two copies of its workspace.
  await assert.rejects(readFile(raw))
})

test('wrapping refuses an image that is not there rather than writing a footer alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vhd-'))
  await assert.rejects(
    wrapImageAsFixedVhd(join(directory, 'missing.img'), join(directory, 'missing.vhd')),
    /missing before it could be attached/,
  )
})
