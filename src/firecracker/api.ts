import { request as httpRequest } from 'node:http'

import { WorkspacePathError } from '../workspace-paths.js'

const API_REQUEST_TIMEOUT_MS = 10_000
const API_ERROR_MAX_BYTES = 4_096

/**
 * Firecracker's control plane is a REST API served on a Unix socket
 * (docs/getting-started.md). Every configuration call is a `PUT` that answers
 * `204 No Content`; anything else is a refusal we must not paper over, so the
 * body is read only to name the failure and never to retry.
 *
 * Node's `http` client speaks HTTP/1.1 over a Unix socket through
 * `socketPath`, which is exactly what `curl --unix-socket` does in the docs.
 */
export const firecrackerApiPut = async (
  socketPath: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  await new Promise<void>((resolvePromise, reject) => {
    const fail = (message: string): void => reject(new WorkspacePathError(message))
    const call = httpRequest({
      headers: {
        accept: 'application/json',
        'content-length': String(payload.byteLength),
        'content-type': 'application/json',
        host: 'localhost',
      },
      method: 'PUT',
      path,
      socketPath,
      timeout: API_REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size <= API_ERROR_MAX_BYTES) chunks.push(chunk)
      })
      response.once('end', () => {
        if (response.statusCode === 204) {
          resolvePromise()
          return
        }
        const detail = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim()
        fail(
          `The executor micro-VM refused ${path} with HTTP ${response.statusCode ?? 0}`
          + `${detail ? `: ${detail}` : '.'}`,
        )
      })
    })
    call.once('timeout', () => {
      call.destroy()
      fail(`The executor micro-VM did not answer ${path}.`)
    })
    call.once('error', () => fail(`The executor micro-VM control socket is unavailable (${path}).`))
    call.end(payload)
  })
}

export type FirecrackerDrive = {
  driveId: string
  imagePath: string
  readOnly: boolean
}

/**
 * docs/getting-started.md configures a drive with exactly these four fields.
 * `is_root_device` is always false here: the guest boots from its initrd, and
 * docs/initrd.md forbids a root device alongside `initrd_path`. The guest
 * mounts these by device node in attach order (`GUEST_BLOCK_DEVICE_ORDER`).
 */
export const putFirecrackerDrive = (socketPath: string, drive: FirecrackerDrive): Promise<void> =>
  firecrackerApiPut(socketPath, `/drives/${drive.driveId}`, {
    drive_id: drive.driveId,
    is_read_only: drive.readOnly,
    is_root_device: false,
    path_on_host: drive.imagePath,
  })

/**
 * The exact configuration sequence, in the order Firecracker requires: boot
 * source, machine configuration, vsock and drives must all precede
 * `InstanceStart`, and `InstanceStart` "can only be successfully called once"
 * (docs/api_requests/actions.md).
 *
 * There is deliberately no `PUT /network-interfaces` call. The guest gets no
 * network device at all; every byte of egress leaves through the daemon's
 * forced gateway over the vsock channel, exactly as on macOS.
 */
export const configureFirecrackerMicroVm = async (
  socketPath: string,
  input: {
    bootArgs: string
    drives: readonly FirecrackerDrive[]
    guestCid: number
    initrdPath: string
    kernelPath: string
    memoryMiB: number
    udsPath: string
    vcpuCount: number
  },
): Promise<void> => {
  // docs/initrd.md: `initrd_path` boots the guest from the initrd, and no drive
  // may be `is_root_device` alongside it.
  await firecrackerApiPut(socketPath, '/boot-source', {
    boot_args: input.bootArgs,
    initrd_path: input.initrdPath,
    kernel_image_path: input.kernelPath,
  })
  await firecrackerApiPut(socketPath, '/machine-config', {
    mem_size_mib: input.memoryMiB,
    smt: false,
    track_dirty_pages: false,
    vcpu_count: input.vcpuCount,
  })
  // docs/vsock.md: `guest_cid` is the guest's own CID (host is always 2), and
  // `uds_path` is the host Unix socket Firecracker binds for host-initiated
  // connections. Guest-initiated connections are forwarded to
  // `<uds_path>_<port>`, which the caller must already be listening on.
  await firecrackerApiPut(socketPath, '/vsock', {
    guest_cid: input.guestCid,
    uds_path: input.udsPath,
  })
  // Sequential, never concurrent: attach order is what names these devices
  // inside the guest.
  for (const drive of input.drives) await putFirecrackerDrive(socketPath, drive)
}

export const startFirecrackerInstance = (socketPath: string): Promise<void> =>
  firecrackerApiPut(socketPath, '/actions', { action_type: 'InstanceStart' })

/**
 * `SendCtrlAltDel` is documented as "[Intel and AMD only]"
 * (docs/api_requests/actions.md): it emulates an i8042 keyboard, which aarch64
 * micro-VMs do not have. It is therefore best-effort — the caller still waits
 * for the process to exit and kills the micro-VM on timeout.
 */
export const sendFirecrackerCtrlAltDel = (socketPath: string): Promise<void> =>
  firecrackerApiPut(socketPath, '/actions', { action_type: 'SendCtrlAltDel' })
