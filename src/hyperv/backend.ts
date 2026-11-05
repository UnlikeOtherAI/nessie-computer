import { constants } from 'node:fs'
import { open, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Socket } from 'node:net'

import {
  GUEST_CONTROL_PORT,
  GUEST_EGRESS_PORT,
  startGuestControlChannel,
  startGuestEgressBridge,
  type GuestChannelListener,
} from '../firecracker/index.js'
import {
  guestVmSessionProcess,
  type ActiveGuestVmSessionProcess,
  type GuestVmBackend,
  type GuestVmBackendStartInput,
} from '../guest-vm-backend.js'
import { GuestVmControlClient } from '../guest-vm-control.js'
import { buildGuestBlockImages, type GuestImageDependencies } from '../guest-images.js'
import { WorkspacePathError } from '../workspace-paths.js'
import { buildGuestBootImage } from './boot-disk.js'
import {
  assertHyperVHostReady,
  hyperVLayout,
  hyperVPipePath,
  type HyperVHostProbe,
} from './layout.js'
import { createGuestPipeListener } from './pipe-transport.js'
import {
  createPinnedScriptStore,
  readPinnedScriptDigests,
  type PinnedScriptDigests,
} from './scripts.js'
import { startHyperVBridges, type HyperVBridge, type HyperVBridgeSpawner } from './bridge.js'
import { createGuestVmController, type HyperVProcessRunner } from './vm.js'
import { runPowerShell } from './powershell.js'
import { wrapImageAsFixedVhd } from './vhd.js'

const GRACEFUL_STOP_TIMEOUT_MS = 10_000
const CONSOLE_PORT = 49_151

/**
 * The kernel command line **compiled into** the guest kernel. Hyper-V's
 * generation 2 firmware boots `\EFI\BOOT\BOOTX64.EFI` with empty UEFI load
 * options and offers no way to set them, so this static line is the only one
 * the kernel has. Everything that varies per session — which shares are
 * attached, the runtime manifest digest, whether there is a gateway — travels
 * in the initrd instead, which `nessie.args=initrd` tells the guest to read.
 *
 * `executor/guest/kernel/config` must carry exactly this as `CONFIG_CMDLINE`,
 * and the test beside this file is what keeps the two from drifting.
 */
export const HYPERV_BUILTIN_BOOT_ARGS =
  'console=ttyS0 reboot=k panic=1 rdinit=/init nessie.args=initrd initrd=\\EFI\\BOOT\\initrd.img'

/**
 * The per-session half, written into the initrd by
 * `build-initrd --boot-args`. It is the same `nessie.*` vocabulary Firecracker
 * writes onto the real command line, so the guest reads one joined line and
 * never learns which host it is on.
 */
export const hyperVSessionBootArgs = (input: {
  egress: boolean
  runtimeManifestDigest: string
}): string => [
  `nessie.runtime_manifest=${input.runtimeManifestDigest}`,
  'nessie.runtime=1',
  'nessie.workspace=1',
  'nessie.shares=block',
  ...(input.egress ? ['nessie.egress=1'] : []),
].join(' ')

/**
 * Windows has no POSIX identity to mirror, and the guest's only requirement is
 * that the account owning `/work` is not root — it refuses to boot otherwise
 * rather than leave a privileged workload inside the sandbox. So the images are
 * built for one fixed unprivileged id, which exists only inside the guest.
 */
export const HYPERV_GUEST_IMAGE_IDENTITY = { gid: 1_000, uid: 1_000 }

type HyperVSessionResources = {
  bridges?: HyperVBridge
  console?: { close: () => Promise<void> }
  created?: boolean
  diskDirectory?: string
  egress?: { close: () => Promise<void> }
  control?: Awaited<ReturnType<typeof startGuestControlChannel>>
  started?: boolean
}

export type HyperVBackendDependencies = {
  /** Injected by the tests in place of the installed package manifest. */
  digests?: PinnedScriptDigests
  hostProbe?: HyperVHostProbe
  images?: GuestImageDependencies
  listenPort?: GuestChannelListener
  runScript?: HyperVProcessRunner
  spawnBridge?: HyperVBridgeSpawner
  systemRoot?: string
}

const defaultHostProbe = (): HyperVHostProbe => ({
  exists: (path) => stat(path).then(() => true).catch(() => false),
})

/**
 * The serial console, so a boot that dies before the control hello leaves
 * evidence. Hyper-V connects a virtual COM port to a named pipe **as a
 * client**, so the daemon is the listener, exactly as it is for the two guest
 * channels — one transport, three uses.
 */
const startConsoleSink = async (
  listen: GuestChannelListener,
  pipePrefix: string,
  consolePath: string,
): Promise<{ close: () => Promise<void> }> => {
  const handle = await open(
    consolePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ).catch(() => undefined)
  const sink = handle?.createWriteStream()
  const listener = await listen(pipePrefix, CONSOLE_PORT, (socket: Socket) => {
    if (sink) socket.pipe(sink)
    else socket.resume()
  })
  return {
    close: async () => {
      await listener.close()
      sink?.end()
    },
  }
}

const releaseSession = async (
  resources: HyperVSessionResources,
  vm: ReturnType<typeof createGuestVmController>,
  vmName: string,
): Promise<void> => {
  await resources.egress?.close().catch(() => undefined)
  await resources.control?.close().catch(() => undefined)
  await resources.bridges?.close().catch(() => undefined)
  await resources.console?.close().catch(() => undefined)
  if (resources.created) {
    if (resources.started) await vm.stop(vmName, 'turnoff').catch(() => undefined)
    await vm.remove(vmName).catch(() => undefined)
  }
  if (resources.diskDirectory) {
    // A surviving disk is a surviving copy of the workspace.
    await rm(resources.diskDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })

/**
 * Windows: one Hyper-V generation 2 virtual machine per session, created and
 * destroyed through four pinned PowerShell scripts and reached over Hyper-V
 * sockets. It configures **no network adapter** — `New-VM` always makes one, so
 * `create.ps1` removes it — and the guest's only route off the machine is the
 * same forced-egress gateway it has on every other host.
 *
 * On Windows the executor's stored `vmHelperPath` is
 * `nessie-hyperv-bridge.exe`; the scripts, the kernel and the initrd builder are
 * its siblings under the installed resource root, the same way the Linux
 * package's `build-initrd` finds `init` beside itself. The boot disk itself is
 * written in-process by `fat32.ts`, so the package ships no filesystem tool.
 */
export const createHyperVBackend = (
  dependencies: HyperVBackendDependencies = {},
): GuestVmBackend => ({
  kind: 'hyperv',
  start: async (input: GuestVmBackendStartInput): Promise<ActiveGuestVmSessionProcess> => {
    const systemRoot = dependencies.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows'
    await assertHyperVHostReady(systemRoot, dependencies.hostProbe ?? defaultHostProbe())
    const resourcesDirectory = dirname(input.vmHelperPath)
    const vm = createGuestVmController({
      powerShellPath: join(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
      run: dependencies.runScript ?? runPowerShell,
      scripts: createPinnedScriptStore({
        digests: dependencies.digests ?? await readPinnedScriptDigests(resourcesDirectory),
        resourcesDirectory,
      }),
    })
    const layout = hyperVLayout({ sessionDirectory: input.sessionDirectory, sessionId: input.sessionId })
    const listen = dependencies.listenPort ?? createGuestPipeListener()
    const resources: HyperVSessionResources = { diskDirectory: layout.diskDirectory }
    try {
      await mkdir(layout.diskDirectory, { mode: 0o700, recursive: true })
      const images = await buildGuestBlockImages({
        directory: input.sessionDirectory,
        runtimeSnapshotPath: input.runtimeSnapshotPath,
        workspacePath: input.workspacePath,
      }, { identity: HYPERV_GUEST_IMAGE_IDENTITY, ...dependencies.images })
      await buildGuestBootImage({
        imagePath: layout.bootImagePath,
        initrdPath: input.initrdPath,
        kernelPath: input.kernelPath,
      })
      const disks = await wrapSessionDisks(layout, images)
      resources.console = await startConsoleSink(listen, layout.pipePrefix, input.consolePath)
      // Both guest channels listen before the machine exists, let alone runs.
      resources.control = await startGuestControlChannel(
        layout.pipePrefix,
        input.bootstrapToken,
        listen,
      )
      if (input.egressGatewaySocketPath) {
        resources.egress = await startGuestEgressBridge({
          bootstrapToken: input.bootstrapToken,
          gatewaySocketPath: input.egressGatewaySocketPath,
          listenPort: listen,
          vsockPath: layout.pipePrefix,
        })
      }
      const vmId = await vm.create({
        ...disks,
        consolePipePath: hyperVPipePath(layout.pipePrefix, CONSOLE_PORT),
        memoryMiB: input.resources.memoryMiB,
        vcpuCount: input.resources.vcpuCount,
        vmDirectory: layout.diskDirectory,
        vmName: layout.vmName,
      })
      resources.created = true
      resources.bridges = startHyperVBridges({
        bridgePath: input.vmHelperPath,
        pipePrefix: layout.pipePrefix,
        ports: [GUEST_CONTROL_PORT, GUEST_EGRESS_PORT, CONSOLE_PORT],
        ...(dependencies.spawnBridge ? { spawnProcess: dependencies.spawnBridge } : {}),
        vmId,
      })
      await vm.start(layout.vmName)
      resources.started = true
      const guest = await Promise.race([
        resources.control.connected,
        delay(input.readyTimeoutMs).then(() => {
          throw new WorkspacePathError('The executor guest did not open its control channel in time.')
        }),
      ])
      const control = new GuestVmControlClient(guest.input, guest.output)
      await control.waitForReady(input.readyTimeoutMs)
      let stopping: Promise<void> | undefined
      const closed = new Promise<void>((resolvePromise) => { guest.input.once('close', resolvePromise) })
        .finally(() => control.close())
      const stop = async (): Promise<void> => {
        stopping ??= (async () => {
          // Closing the control channel is what ends this guest: its init
          // returns on EOF. `Stop-VM` — with or without `-Force` — asks the
          // guest to shut itself down through the shutdown integration
          // service, which an initramfs does not run, so there is nobody there
          // to answer it; `-TurnOff` is what the timeout falls to.
          guest.input.end()
          await Promise.race([closed, delay(GRACEFUL_STOP_TIMEOUT_MS)])
          await releaseSession(resources, vm, layout.vmName)
        })()
        await stopping
      }
      return {
        ...guestVmSessionProcess(control, { closed, stop }),
        readDraft: (path, offset) => control.readDraft(path, offset),
        scanDrafts: (cursor) => control.scanDrafts(cursor),
      }
    } catch (error) {
      await releaseSession(resources, vm, layout.vmName)
      throw error
    }
  },
})

/** Kept out of `start` so the disk names stay one readable statement. */
const wrapSessionDisks = async (
  layout: ReturnType<typeof hyperVLayout>,
  images: Awaited<ReturnType<typeof buildGuestBlockImages>>,
): Promise<{
  bootVhdPath: string
  draftVhdPath: string
  runtimeVhdPath: string
  workspaceVhdPath: string
}> => {
  return {
    bootVhdPath: await wrapImageAsFixedVhd(layout.bootImagePath, layout.bootVhdPath),
    draftVhdPath: await wrapImageAsFixedVhd(images.draft.path, join(layout.diskDirectory, 'draft.vhd')),
    runtimeVhdPath: await wrapImageAsFixedVhd(images.runtime.path, join(layout.diskDirectory, 'runtime.vhd')),
    workspaceVhdPath: await wrapImageAsFixedVhd(
      images.workspace.path,
      join(layout.diskDirectory, 'workspace.vhd'),
    ),
  }
}
