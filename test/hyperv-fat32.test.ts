import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  bootDiskSizeBytes,
  bootDiskTree,
  buildFat32Image,
  buildGuestBootImage,
  fat32Geometry,
  BOOT_DISK_INITRD_PATH,
  BOOT_DISK_LABEL,
  BOOT_DISK_LOADER_PATH,
  FAT32_MINIMUM_CLUSTER_COUNT,
  FAT32_SECTOR_BYTES,
} from '../src/hyperv/index.js'
import { readFat32Directory, readFat32File, readFat32Volume } from './fat32-reader.js'

const run = promisify(execFile)
const MEBIBYTE = 1024 * 1024

/** The external checks below need FAT tools this repository does not ship. */
const hasTool = async (name: string): Promise<boolean> =>
  run('sh', ['-c', `command -v ${name}`]).then(() => true).catch(() => false)

const stageBootDisk = async (input: { initrd: Buffer; kernel: Buffer }): Promise<{
  directory: string
  image: Buffer
  imagePath: string
  sizeBytes: number
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-fat32-'))
  const kernelPath = join(directory, 'bzImage')
  const initrdPath = join(directory, 'guest-initrd')
  await writeFile(kernelPath, input.kernel)
  await writeFile(initrdPath, input.initrd)
  const imagePath = join(directory, 'boot.img')
  const built = await buildGuestBootImage({ imagePath, initrdPath, kernelPath })
  return { directory, image: await readFile(imagePath), imagePath, sizeBytes: built.sizeBytes }
}

test('the boot disk geometry stays a FAT32 volume the specification recognises', () => {
  const geometry = fat32Geometry(64 * MEBIBYTE)
  assert.equal(geometry.totalSectors, (64 * MEBIBYTE) / FAT32_SECTOR_BYTES)
  assert.equal(geometry.reservedSectors, 32)
  // §3.5's DskTableFAT32: a volume up to 260 MB takes half-kilobyte clusters.
  assert.equal(geometry.sectorsPerCluster, 1)
  // Under 65,525 clusters the same bytes would *be* a FAT16 volume, and the
  // firmware would read the wrong file system out of the same BPB.
  assert.ok(geometry.clusterCount > FAT32_MINIMUM_CLUSTER_COUNT)
  // Its own smallest disk is 32.5 MB, so anything under that has no answer.
  assert.throws(() => fat32Geometry(16 * MEBIBYTE), /too small to hold a FAT32 volume/)
  assert.throws(() => fat32Geometry(64 * MEBIBYTE + 1), /whole number of 512-byte sectors/)
  // A boot payload larger than the disk is refused rather than truncated.
  assert.throws(() => bootDiskSizeBytes(512 * MEBIBYTE), /exceed the boot disk limit/)
  assert.equal(bootDiskSizeBytes(4096), 64 * MEBIBYTE)
})

test('the boot disk carries the loader and this session initrd at the paths the firmware reads', async () => {
  const kernel = randomBytes(3 * MEBIBYTE + 17)
  const initrd = randomBytes(MEBIBYTE + 4095)
  const staged = await stageBootDisk({ initrd, kernel })
  try {
    const volume = readFat32Volume(staged.image)
    assert.equal(volume.label, BOOT_DISK_LABEL)
    assert.equal(volume.rootCluster, 2)
    assert.ok(volume.clusterCount > FAT32_MINIMUM_CLUSTER_COUNT)
    // Read back through a reader that knows only the on-disk BPB, so the two
    // implementations agree about the format rather than about each other.
    assert.deepEqual(readFat32File(staged.image, BOOT_DISK_LOADER_PATH), kernel)
    assert.deepEqual(readFat32File(staged.image, BOOT_DISK_INITRD_PATH), initrd)
    // §6.1: a subdirectory opens with `.` and `..`, and a `..` whose parent
    // *is* the root names cluster 0 rather than the root's real cluster —
    // fsck.fat calls the latter an "Invalid '..' entry in the second slot".
    const efi = readFat32Directory(staged.image, 'EFI')
    assert.deepEqual(efi.slice(0, 2).map((entry) => entry.shortName), ['.', '..'])
    assert.equal(efi[1]!.firstCluster, 0)
    const entries = readFat32Directory(staged.image, 'EFI/BOOT')
    assert.deepEqual(entries.slice(0, 2).map((entry) => entry.shortName), ['.', '..'])
    // One level down, `..` names the real cluster of EFI — its own `.` entry.
    assert.equal(entries[1]!.firstCluster, efi[0]!.firstCluster)
    // `BOOTX64.EFI` already *is* its 8.3 name, so it needs no long entry;
    // `initrd.img` is lowercase, so its exact spelling lives in one.
    assert.equal(entries[2]!.shortName, 'BOOTX64.EFI')
    assert.equal(entries[2]!.longName, '')
    assert.equal(entries[3]!.shortName, 'INITRD~1.IMG')
    assert.equal(entries[3]!.longName, 'initrd.img')
    assert.equal(entries[3]!.sizeBytes, initrd.byteLength)
    // §6.1: the root opens with the volume label — an entry carrying
    // ATTR_VOLUME_ID whose 11 name bytes are the label, not an 8.3 name — and
    // holds the one directory after it.
    const root = readFat32Directory(staged.image, '')
    assert.equal(root[0]!.attributes, 0x08)
    assert.deepEqual(root.slice(1).map((entry) => entry.shortName), ['EFI'])
  } finally {
    await rm(staged.directory, { force: true, recursive: true })
  }
})

test('two builds of the same kernel and initrd are the same bytes', async () => {
  const kernel = randomBytes(2 * MEBIBYTE)
  const initrd = randomBytes(64 * 1024 + 3)
  const first = await stageBootDisk({ initrd, kernel })
  const second = await stageBootDisk({ initrd, kernel })
  try {
    const digest = (image: Buffer): string => createHash('sha256').update(image).digest('hex')
    assert.equal(digest(first.image), digest(second.image))
    assert.equal(first.sizeBytes, second.sizeBytes)
    // Nothing outside the written objects carries a value, so the slack a
    // release compares is zero rather than whatever the allocator last held.
    const volume = readFat32Volume(first.image)
    const tail = first.image.subarray(first.image.byteLength - volume.bytesPerCluster)
    assert.ok(tail.every((byte) => byte === 0))
  } finally {
    await rm(first.directory, { force: true, recursive: true })
    await rm(second.directory, { force: true, recursive: true })
  }
})

test('a name that cannot be stored on FAT32 is refused rather than mangled', () => {
  const build = (name: string): Buffer => buildFat32Image({
    label: BOOT_DISK_LABEL,
    root: [{ content: Buffer.alloc(1), kind: 'file', name }],
    sizeBytes: 64 * MEBIBYTE,
  })
  assert.throws(() => build('boot loader.efi'), /cannot be stored on FAT32/)
  assert.throws(() => build('BOOTX64.EFIX'), /cannot be stored on FAT32/)
  assert.throws(() => buildFat32Image({
    label: 'not a label',
    root: bootDiskTree({ initrd: Buffer.alloc(1), kernel: Buffer.alloc(1) }),
    sizeBytes: 64 * MEBIBYTE,
  }), /volume label is invalid/)
})

test('the boot disk passes fsck.fat and mtools where they are installed', async () => {
  if (!await hasTool('fsck.fat') || !await hasTool('mdir')) {
    // Not a silent pass: the suite above proves the same image through its own
    // reader, and this test states which external confirmation was unavailable.
    console.log('# skipped external FAT check: fsck.fat and mtools are not installed')
    return
  }
  const kernel = randomBytes(2 * MEBIBYTE + 5)
  const initrd = randomBytes(512 * 1024)
  const staged = await stageBootDisk({ initrd, kernel })
  const environment = { ...process.env, MTOOLS_SKIP_CHECK: '1' }
  try {
    // `-n` opens the volume read-only, so a repair can never mask a defect.
    const checked = await run('fsck.fat', ['-n', staged.imagePath], { env: environment })
    assert.doesNotMatch(checked.stdout, /Invalid|Fixing|Corrupt/i)
    const listed = await run('mdir', ['-i', staged.imagePath, '::/EFI/BOOT'], { env: environment })
    assert.match(listed.stdout, /BOOTX64\s+EFI/)
    assert.match(listed.stdout, /initrd\.img/)
    const copied = await run(
      'mcopy',
      ['-i', staged.imagePath, `::/${BOOT_DISK_LOADER_PATH}`, '-'],
      { encoding: 'buffer', env: environment, maxBuffer: 64 * MEBIBYTE },
    )
    assert.deepEqual(copied.stdout, kernel)
  } finally {
    await rm(staged.directory, { force: true, recursive: true })
  }
})
