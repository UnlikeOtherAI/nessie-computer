import { join } from 'node:path'

import { GUEST_IMAGE_LABELS, type GuestImageLabel } from '../guest-images.js'
import { WorkspacePathError } from '../workspace-paths.js'

/** A session id reaches a VM name, a pipe name and a file name: it is validated. */
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/

/** The Hyper-V Virtual Machine Management service; present iff the feature is. */
export const WINDOWS_HYPERV_SERVICE_BINARY = 'System32\\vmms.exe'

/** Windows PowerShell, which carries the in-box Hyper-V module. */
export const POWERSHELL_PATH = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'

export const HYPERV_VM_NAME_PREFIX = 'nessie-executor-'

/**
 * The order the host attaches the disks on the one SCSI controller, and the
 * only bus a generation 2 machine has: "Generation 2 virtual machines can boot
 * from a virtual hard disk or DVD that is attached to the SCSI controller. The
 * virtual Integrated Device Electronics (IDE) controller is not available in
 * generation 2 virtual machines."
 *
 * Location 0 is the boot disk. **The guest does not read these positions.**
 * Linux names hv_storvsc disks as they finish probing, not as they were
 * attached, so `executor/guest/mounts_linux.go` finds each image by its ext4
 * label; the fixed order here exists so a person reading `Get-VMHardDiskDrive`
 * sees the same picture twice running, and so the boot disk is unambiguous.
 */
export const GUEST_SCSI_ATTACH_ORDER: ReadonlyArray<{
  controllerLocation: number
  driveId: string
  label: GuestImageLabel
  readOnly: boolean
}> = [
  { controllerLocation: 1, driveId: 'runtime', label: GUEST_IMAGE_LABELS.runtime, readOnly: true },
  { controllerLocation: 2, driveId: 'workspace', label: GUEST_IMAGE_LABELS.workspace, readOnly: true },
  { controllerLocation: 3, driveId: 'draft', label: GUEST_IMAGE_LABELS.draft, readOnly: false },
]

export const GUEST_BOOT_CONTROLLER_LOCATION = 0

export const assertHyperVSessionId = (sessionId: string): string => {
  if (!SESSION_ID.test(sessionId)) {
    throw new WorkspacePathError('The executor guest VM session id is invalid.')
  }
  return sessionId
}

export type HyperVLayout = {
  /** The FAT image the firmware boots: EFI\BOOT\BOOTX64.EFI plus the initrd. */
  bootImagePath: string
  bootVhdPath: string
  /** Owner-only directory holding every disk this session ever writes. */
  diskDirectory: string
  /** The prefix both guest channels hang their named pipes off. */
  pipePrefix: string
  vmName: string
}

/**
 * Named pipes live in one flat kernel namespace, so the session id is the only
 * thing keeping two sessions — or two people on one computer — apart. The
 * `<prefix>-<port>` shape mirrors Firecracker's `<uds_path>_<port>` rule, so the
 * control and egress channels above this are the same code on both backends.
 */
export const hyperVPipePath = (pipePrefix: string, port: number): string => {
  if (!Number.isInteger(port) || port < 1 || port > 0xffff_ffff) {
    throw new WorkspacePathError('The executor guest VM channel port is invalid.')
  }
  return `${pipePrefix}-${port}`
}

export const hyperVLayout = (input: {
  sessionDirectory: string
  sessionId: string
}): HyperVLayout => {
  const sessionId = assertHyperVSessionId(input.sessionId)
  const diskDirectory = join(input.sessionDirectory, 'disks')
  return {
    bootImagePath: join(diskDirectory, 'boot.img'),
    bootVhdPath: join(diskDirectory, 'boot.vhd'),
    diskDirectory,
    pipePrefix: `\\\\.\\pipe\\nessie-hv-${sessionId}`,
    vmName: `${HYPERV_VM_NAME_PREFIX}${sessionId}`,
  }
}

export type HyperVHostProbe = { exists: (path: string) => Promise<boolean> }

const HYPERV_REMEDY =
  'This computer does not have Hyper-V, so a sandboxed guest cannot start. Sandboxed commands, '
  + 'browsers, and coding sessions need Hyper-V, which is available on Windows 11 Pro, Enterprise, '
  + 'and Education with virtualization enabled in firmware.'

/**
 * Fails closed before a disk is built, rather than letting the first cmdlet
 * fail with an error nobody can attribute. This is the same fact
 * `detectExecutorHost` reads to decide the backend at all, asked again here
 * because the descriptor is a snapshot and the feature can be removed.
 */
export const assertHyperVHostReady = async (
  systemRoot: string,
  probe: HyperVHostProbe,
): Promise<void> => {
  if (!await probe.exists(join(systemRoot, WINDOWS_HYPERV_SERVICE_BINARY))) {
    throw new WorkspacePathError(HYPERV_REMEDY)
  }
}
