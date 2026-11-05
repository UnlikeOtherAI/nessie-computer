import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'

import { secureFirecrackerSocketDirectory } from '../guest-vm-artifacts.js'
import {
  guestVmSessionProcess,
  stopChildProcess,
  waitForChildExit,
  type ActiveGuestVmSessionProcess,
  type GuestVmBackend,
  type GuestVmBackendStartInput,
} from '../guest-vm-backend.js'
import { GuestVmControlClient } from '../guest-vm-control.js'
import {
  buildGuestBlockImages,
  type GuestBlockImages,
  type GuestImageDependencies,
} from '../guest-images.js'
import { WorkspacePathError } from '../workspace-paths.js'
import {
  configureFirecrackerMicroVm,
  sendFirecrackerCtrlAltDel,
  startFirecrackerInstance,
  type FirecrackerDrive,
} from './api.js'
import { startGuestControlChannel } from './control-channel.js'
import { startGuestEgressBridge, type GuestEgressBridge } from './egress-bridge.js'
import {
  assertFirecrackerBinary,
  assertFirecrackerHostReady,
  buildFirecrackerArgv,
  firecrackerLayout,
  GUEST_BLOCK_DEVICE_ORDER,
  type FirecrackerHostProbe,
} from './layout.js'

/**
 * Firecracker's guest CID. The host is always 2 (docs/vsock.md); 3 is the
 * conventional first guest CID and each micro-VM has its own vsock device
 * backed by its own Unix socket, so the value never collides.
 */
const GUEST_CID = 3
const API_SOCKET_POLL_INTERVAL_MS = 25
const API_SOCKET_TIMEOUT_MS = 10_000
const GRACEFUL_STOP_TIMEOUT_MS = 10_000

export type FirecrackerProcessSpawner = (path: string, argv: string[], consolePath: string) => ChildProcess

/**
 * The guest's serial console goes to the session's own owner-only console file
 * rather than being discarded, because a boot that fails before the control
 * hello leaves no other evidence. It is session material and is removed with
 * the session.
 */
const spawnFirecracker: FirecrackerProcessSpawner = (path, argv, consolePath) => {
  // argv is a list, never a shell string: nothing here is interpreted by a
  // shell, so a path can never become an argument.
  const child = spawn(path, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  void open(consolePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .then((handle) => {
      const sink = handle.createWriteStream()
      child.stdout?.pipe(sink)
      child.stderr?.pipe(sink)
    })
    .catch(() => {
      child.stdout?.resume()
      child.stderr?.resume()
    })
  return child
}

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })

/** Firecracker binds its API socket asynchronously; that socket is its "ready". */
const awaitApiSocket = async (
  apiSocketPath: string,
  child: ChildProcess,
  now: () => number,
): Promise<void> => {
  const deadline = now() + API_SOCKET_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new WorkspacePathError('The executor micro-VM exited before its control socket appeared.')
    }
    const info = await stat(apiSocketPath).catch(() => undefined)
    if (info?.isSocket()) return
    if (now() >= deadline) {
      throw new WorkspacePathError('The executor micro-VM did not open its control socket in time.')
    }
    await delay(API_SOCKET_POLL_INTERVAL_MS)
  }
}

/**
 * The guest's kernel command line. `console=ttyS0 reboot=k panic=1 pci=off` is
 * Firecracker's own documented baseline (docs/initrd.md); `rdinit=/init` names
 * the guest init inside the initrd; and the `nessie.*` flags are the exact ones
 * `executor/guest` reads back out of /proc/cmdline.
 *
 * `nessie.shares=block` is the one place the two hypervisors' guests differ:
 * Firecracker implements no virtio-fs device, so `/runtime` and `/work` come
 * from virtio-block images instead of virtiofs tags. The flag is absent under
 * Virtualization.framework and the guest then keeps its virtiofs strategy, so
 * the macOS boot contract is byte-identical to before.
 */
export const guestBootArgs = (input: {
  egress: boolean
  runtimeManifestDigest: string
}): string => [
  'console=ttyS0',
  'reboot=k',
  'panic=1',
  'pci=off',
  'rdinit=/init',
  `nessie.runtime_manifest=${input.runtimeManifestDigest}`,
  'nessie.runtime=1',
  'nessie.workspace=1',
  'nessie.shares=block',
  ...(input.egress ? ['nessie.egress=1'] : []),
].join(' ')

/** The attach order is the contract; `GUEST_BLOCK_DEVICE_ORDER` states it. */
export const guestDrives = (images: GuestBlockImages): FirecrackerDrive[] =>
  GUEST_BLOCK_DEVICE_ORDER.map(({ driveId, readOnly }) => {
    const image = images[driveId as 'draft' | 'runtime' | 'workspace']
    return { driveId, imagePath: image.path, readOnly }
  })

type FirecrackerSessionResources = {
  bridge?: GuestEgressBridge
  channel?: Awaited<ReturnType<typeof startGuestControlChannel>>
  child?: ChildProcess
  imageDirectory?: string
  socketDirectory?: string
}

/**
 * Tears a session down in the reverse of the order it was built. Nothing is
 * left behind: the socket root carries the API socket and both guest channels,
 * and the image directory carries the guest's whole filesystem, so a surviving
 * directory is a surviving capability.
 */
const releaseSession = async (resources: FirecrackerSessionResources): Promise<void> => {
  await resources.bridge?.close().catch(() => undefined)
  await resources.channel?.close().catch(() => undefined)
  if (resources.child) await stopChildProcess(resources.child, GRACEFUL_STOP_TIMEOUT_MS).catch(() => undefined)
  if (resources.socketDirectory) {
    await rm(resources.socketDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
  if (resources.imageDirectory) {
    await rm(resources.imageDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

export type FirecrackerBackendDependencies = {
  hostProbe?: FirecrackerHostProbe
  images?: GuestImageDependencies
  now?: () => number
  /** Injected in tests; production spawns the real Firecracker binary. */
  spawnProcess?: FirecrackerProcessSpawner
}

/**
 * Linux: one Firecracker micro-VM per session, run directly by the daemon. No
 * network interface is ever configured — the guest's only route off the machine
 * is the forced egress gateway over vsock, exactly as under
 * Virtualization.framework — and no jailer is involved, because the jailer is
 * documented as needing root and neither Linux supervisor has it (see
 * `layout.ts`). Firecracker's default seccomp filter stays on.
 *
 * On Linux the executor's stored `vmHelperPath` is the Firecracker binary.
 */
export const createFirecrackerBackend = (
  dependencies: FirecrackerBackendDependencies = {},
): GuestVmBackend => {
  const now = dependencies.now ?? Date.now
  const spawnProcess = dependencies.spawnProcess ?? spawnFirecracker
  return {
    kind: 'firecracker',
    start: async (input: GuestVmBackendStartInput): Promise<ActiveGuestVmSessionProcess> => {
      await assertFirecrackerHostReady(dependencies.hostProbe)
      const firecrackerPath = await assertFirecrackerBinary(input.vmHelperPath)
      const images = await buildGuestBlockImages({
        directory: input.sessionDirectory,
        runtimeSnapshotPath: input.runtimeSnapshotPath,
        workspacePath: input.workspacePath,
      }, dependencies.images)
      const socketDirectory = await secureFirecrackerSocketDirectory()
      const layout = firecrackerLayout({ sessionId: input.sessionId, socketDirectory })
      const resources: FirecrackerSessionResources = {
        imageDirectory: images.directory,
        socketDirectory,
      }
      try {
        const child = spawnProcess(
          firecrackerPath,
          buildFirecrackerArgv({ apiSocketPath: layout.apiSocketPath, sessionId: input.sessionId }),
          input.consolePath,
        )
        resources.child = child
        await awaitApiSocket(layout.apiSocketPath, child, now)
        await configureFirecrackerMicroVm(layout.apiSocketPath, {
          bootArgs: guestBootArgs({
            egress: Boolean(input.egressGatewaySocketPath),
            runtimeManifestDigest: input.runtimeManifestDigest,
          }),
          drives: guestDrives(images),
          guestCid: GUEST_CID,
          initrdPath: input.initrdPath,
          kernelPath: input.kernelPath,
          memoryMiB: input.resources.memoryMiB,
          udsPath: layout.vsockPath,
          vcpuCount: input.resources.vcpuCount,
        })
        // Both guest channels must be listening before the guest can connect,
        // or Firecracker resets the guest's connection (docs/vsock.md).
        resources.channel = await startGuestControlChannel(layout.vsockPath, input.bootstrapToken)
        if (input.egressGatewaySocketPath) {
          resources.bridge = await startGuestEgressBridge({
            bootstrapToken: input.bootstrapToken,
            gatewaySocketPath: input.egressGatewaySocketPath,
            vsockPath: layout.vsockPath,
          })
        }
        await startFirecrackerInstance(layout.apiSocketPath)
        // The same budget covers both halves of becoming ready: a guest that
        // never dials the control port is exactly as dead as one that dials
        // and never authenticates, and neither may hold a session open.
        const guest = await Promise.race([
          resources.channel.connected,
          delay(input.readyTimeoutMs).then(() => {
            throw new WorkspacePathError('The executor guest did not open its control channel in time.')
          }),
        ])
        const control = new GuestVmControlClient(guest.input, guest.output)
        await control.waitForReady(input.readyTimeoutMs)
        let stopping: Promise<void> | undefined
        const closed = waitForChildExit(child).finally(async () => {
          control.close()
          await releaseSession({ ...resources, child: undefined })
        })
        const stop = async (): Promise<void> => {
          stopping ??= (async () => {
            // Closing the control channel is what actually ends this guest: its
            // init returns on EOF. SendCtrlAltDel is the documented graceful
            // action and is attempted anyway, but it is Intel/AMD only, so its
            // refusal must never become the session's failure.
            guest.input.end()
            await sendFirecrackerCtrlAltDel(layout.apiSocketPath).catch(() => undefined)
            await Promise.race([closed, delay(GRACEFUL_STOP_TIMEOUT_MS)])
            await releaseSession(resources)
          })()
          await stopping
        }
        return {
          ...guestVmSessionProcess(control, { closed, stop }),
          // Block-mode shares hold the guest's edits in an image the host does
          // not read, so the session above drains them through the control
          // channel before it stops and whenever a review asks.
          readDraft: (path, offset) => control.readDraft(path, offset),
          scanDrafts: (cursor) => control.scanDrafts(cursor),
        }
      } catch (error) {
        await releaseSession(resources)
        throw error
      }
    },
  }
}
