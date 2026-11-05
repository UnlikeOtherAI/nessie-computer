import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { GUEST_IMAGE_LABELS, type GuestImageLabel } from '../guest-images.js'
import { WorkspacePathError } from '../workspace-paths.js'

/** A session id is part of a Unix socket path; it is validated, never trusted. */
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/

export const FIRECRACKER_API_SOCKET_NAME = 'api.sock'
export const FIRECRACKER_VSOCK_NAME = 'v.sock'

export const KVM_DEVICE_PATH = '/dev/kvm'

/**
 * The order the host attaches drives in, and therefore the order the guest
 * sees them as `/dev/vda`, `/dev/vdb`, `/dev/vdc`: Firecracker's block devices
 * appear in the guest in the order they were configured through the API. That
 * ordering has been an upstream bug before (aarch64 device-tree insertion
 * order, firecracker#1264), so each image also carries an ext4 label and the
 * guest refuses a device whose label is not the one this order promised. The
 * order decides; the label proves.
 *
 * This constant is the host half of the contract stated in
 * `executor/guest/mounts_linux.go`. Changing either without the other is a
 * boot failure at best and a wrong mount at worst.
 */
export const GUEST_BLOCK_DEVICE_ORDER: ReadonlyArray<{
  driveId: string
  label: GuestImageLabel
  readOnly: boolean
}> = [
  { driveId: 'runtime', label: GUEST_IMAGE_LABELS.runtime, readOnly: true },
  { driveId: 'workspace', label: GUEST_IMAGE_LABELS.workspace, readOnly: true },
  { driveId: 'draft', label: GUEST_IMAGE_LABELS.draft, readOnly: false },
]

export type FirecrackerLayout = {
  /** Host path of the REST API socket Firecracker binds for this session. */
  apiSocketPath: string
  /** Host path of the vsock device's Unix socket; channels hang off it. */
  vsockPath: string
}

export const firecrackerLayout = (input: {
  sessionId: string
  socketDirectory: string
}): FirecrackerLayout => {
  if (!SESSION_ID.test(input.sessionId)) {
    throw new WorkspacePathError('The executor micro-VM session id is invalid.')
  }
  return {
    apiSocketPath: join(input.socketDirectory, FIRECRACKER_API_SOCKET_NAME),
    vsockPath: join(input.socketDirectory, FIRECRACKER_VSOCK_NAME),
  }
}

/**
 * Firecracker's own argv, run directly by the daemon. **There is no jailer.**
 *
 * The jailer is documented as running as root — it unshares a mount namespace,
 * `pivot_root`s into a session chroot, `mknod`s `/dev/kvm`, and chowns the jail
 * before dropping privileges (Firecracker docs/jailer.md: "We run the jailer as
 * the root user"). Neither Linux supervisor is root: the standalone package is a
 * systemd *user* service and the desktop supervisor runs as the person. So the
 * backend runs Firecracker itself, in the same posture the upstream
 * getting-started guide uses ("For simplicity, this guide will not use the
 * jailer"), and gets its isolation from what it does *not* configure: no network
 * interface and therefore no TAP device, an owner-only directory for every
 * socket and image, and Firecracker's own **default seccomp filter**, which is
 * on unless `--no-seccomp` is passed and is deliberately never passed here.
 *
 * A privileged launcher that could restore the jailer is a stated non-goal of
 * this release; see docs/plans/2026-09-01-linux-desktop-delivery.md.
 */
export const buildFirecrackerArgv = (input: {
  apiSocketPath: string
  sessionId: string
}): string[] => {
  if (!SESSION_ID.test(input.sessionId)) {
    throw new WorkspacePathError('The executor micro-VM session id is invalid.')
  }
  return ['--api-sock', input.apiSocketPath, '--id', input.sessionId]
}

export type FirecrackerHostProbe = {
  access: (path: string, mode: number) => Promise<void>
}

export const defaultFirecrackerHostProbe = (): FirecrackerHostProbe => ({
  access: (path, mode) => access(path, mode),
})

const KVM_REMEDY =
  'This computer\'s /dev/kvm is not readable and writable by the executor daemon, so a sandboxed guest '
  + 'cannot start. Add this account to the kvm group (and sign in again), or grant it access with '
  + 'setfacl -m u:$USER:rw /dev/kvm.'

/**
 * Fails closed before a micro-VM is configured rather than letting Firecracker
 * exit with an unattributable error once the session has already been staged.
 */
export const assertFirecrackerHostReady = async (
  probe: FirecrackerHostProbe = defaultFirecrackerHostProbe(),
): Promise<void> => {
  await probe.access(KVM_DEVICE_PATH, constants.R_OK | constants.W_OK).catch(() => {
    throw new WorkspacePathError(KVM_REMEDY)
  })
}

/** The Firecracker binary the executor's stored `vmHelperPath` names on Linux. */
export const assertFirecrackerBinary = async (firecrackerPath: string): Promise<string> => {
  const info = await lstat(firecrackerPath).catch(() => undefined)
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspacePathError(`The Firecracker binary is not installed at ${firecrackerPath}.`)
  }
  await access(firecrackerPath, constants.X_OK).catch(() => {
    throw new WorkspacePathError(`The Firecracker binary at ${firecrackerPath} is not executable.`)
  })
  return firecrackerPath
}
