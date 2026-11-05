import { readFile, writeFile } from 'node:fs/promises'

import { WorkspacePathError } from '../workspace-paths.js'
import { buildFat32Image, type Fat32Node } from './fat32.js'

/**
 * The boot disk: a FAT32 volume carrying `EFI\BOOT\BOOTX64.EFI` — the guest
 * kernel, built with `CONFIG_EFI_STUB`, which "can masquerade as a PE/COFF
 * image, thereby convincing EFI firmware loaders to load it as an EFI
 * executable" (Documentation/admin-guide/efi-stub.rst) — and this session's
 * initrd beside it.
 *
 * It is written by `fat32.ts`, the executor's own FAT32 writer. Nothing here
 * needs a loop device, a mount, an administrator, or a third-party binary,
 * which is the same reason the three data images are built with `mke2fs -d`.
 *
 * FAT32 rather than FAT16: the disk is attached as a fixed SCSI drive, so the
 * firmware treats it as a fixed disk, and the UEFI specification's EFI System
 * Partition on a fixed disk is FAT32.
 */
export const BOOT_DISK_LABEL = 'NESSIEBOOT'
const BOOT_DISK_EFI_DIRECTORY = 'EFI'
const BOOT_DISK_BOOT_DIRECTORY = 'BOOT'
/** The removable-media default path a UEFI firmware boots with no NVRAM entry. */
const BOOT_DISK_LOADER_NAME = 'BOOTX64.EFI'
const BOOT_DISK_INITRD_NAME = 'initrd.img'
export const BOOT_DISK_LOADER_PATH = `${BOOT_DISK_EFI_DIRECTORY}/${BOOT_DISK_BOOT_DIRECTORY}/${BOOT_DISK_LOADER_NAME}`
export const BOOT_DISK_INITRD_PATH = `${BOOT_DISK_EFI_DIRECTORY}/${BOOT_DISK_BOOT_DIRECTORY}/${BOOT_DISK_INITRD_NAME}`

const MEBIBYTE = 1024 * 1024
/**
 * FAT32 needs more than 65,525 clusters to be FAT32 at all, and the
 * specification's own cluster-size table has no answer below 32.5 MB. 64 MiB
 * clears that with room for a kernel and an initrd; `fat32Geometry` rejects
 * anything that would not, so the floor is checked rather than assumed. The
 * images are session-scoped and deleted on stop.
 */
const MINIMUM_BOOT_DISK_BYTES = 64 * MEBIBYTE
const BOOT_DISK_SLACK_BYTES = 8 * MEBIBYTE
const MAX_BOOT_PAYLOAD_BYTES = 256 * MEBIBYTE

export const bootDiskSizeBytes = (payloadBytes: number): number => {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
    throw new WorkspacePathError('The executor guest boot payload has no readable size.')
  }
  if (payloadBytes > MAX_BOOT_PAYLOAD_BYTES) {
    throw new WorkspacePathError('The executor guest kernel and initrd exceed the boot disk limit.')
  }
  const wanted = Math.max(payloadBytes + BOOT_DISK_SLACK_BYTES, MINIMUM_BOOT_DISK_BYTES)
  return Math.ceil(wanted / MEBIBYTE) * MEBIBYTE
}

/**
 * The directory tree the firmware expects, kept apart from writing it so it can
 * be asserted on any host. Order is the order the entries are written, and the
 * writer allocates in that order, so the disk is deterministic to its bytes.
 */
export const bootDiskTree = (input: {
  initrd: Uint8Array
  kernel: Uint8Array
}): readonly Fat32Node[] => [
  {
    children: [
      {
        children: [
          { content: input.kernel, kind: 'file', name: BOOT_DISK_LOADER_NAME },
          { content: input.initrd, kind: 'file', name: BOOT_DISK_INITRD_NAME },
        ],
        kind: 'directory',
        name: BOOT_DISK_BOOT_DIRECTORY,
      },
    ],
    kind: 'directory',
    name: BOOT_DISK_EFI_DIRECTORY,
  },
]

export const buildGuestBootImage = async (input: {
  imagePath: string
  initrdPath: string
  kernelPath: string
}): Promise<{ path: string; sizeBytes: number }> => {
  const [kernel, initrd] = await Promise.all([
    readFile(input.kernelPath),
    readFile(input.initrdPath),
  ])
  const sizeBytes = bootDiskSizeBytes(kernel.byteLength + initrd.byteLength)
  const image = buildFat32Image({
    label: BOOT_DISK_LABEL,
    root: bootDiskTree({ initrd, kernel }),
    sizeBytes,
  })
  // Owner-only, and refusing to overwrite: a session's disks are its own.
  await writeFile(input.imagePath, image, { flag: 'wx', mode: 0o600 })
  return { path: input.imagePath, sizeBytes }
}
