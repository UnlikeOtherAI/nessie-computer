import { WorkspacePathError } from '../workspace-paths.js'
import { assertHyperVSessionId, GUEST_BOOT_CONTROLLER_LOCATION, GUEST_SCSI_ATTACH_ORDER } from './layout.js'
import { powerShellArgv, type PinnedScriptStore, type PowerShellParameters } from './scripts.js'

/** Runs one pinned script and returns whatever it wrote to standard output. */
export type HyperVProcessRunner = (input: {
  argv: string[]
  path: string
  timeoutMs: number
}) => Promise<string>

export const HYPERV_CREATE_TIMEOUT_MS = 300_000
export const HYPERV_CONTROL_TIMEOUT_MS = 60_000

/** A Hyper-V VM id is a GUID; it addresses the AF_HYPERV socket, so it is checked. */
export const VM_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export type HyperVGuestDisks = {
  bootVhdPath: string
  draftVhdPath: string
  runtimeVhdPath: string
  workspaceVhdPath: string
}

export type CreateGuestVmInput = HyperVGuestDisks & {
  /** The pipe Hyper-V's virtual COM 1 dials; the daemon is already listening. */
  consolePipePath: string
  memoryMiB: number
  vcpuCount: number
  vmDirectory: string
  vmName: string
}

const positiveInteger = (value: number, label: string): string => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkspacePathError(`The executor guest VM ${label} is invalid.`)
  }
  return String(value)
}

/**
 * The create parameters. The disks are named individually rather than as a list
 * because the script attaches each at a fixed SCSI location, and a positional
 * list would make an accidental reordering silent — `GUEST_SCSI_ATTACH_ORDER`
 * states the same fact on this side.
 */
export const createGuestVmParameters = (input: CreateGuestVmInput): PowerShellParameters => [
  ['VmName', input.vmName],
  ['VmPath', input.vmDirectory],
  ['MemoryMiB', positiveInteger(input.memoryMiB, 'memory size')],
  ['VcpuCount', positiveInteger(input.vcpuCount, 'processor count')],
  ['BootDiskVhd', input.bootVhdPath],
  ['RuntimeDiskVhd', input.runtimeVhdPath],
  ['WorkspaceDiskVhd', input.workspaceVhdPath],
  ['DraftDiskVhd', input.draftVhdPath],
  ['ConsolePipe', input.consolePipePath],
]

export type HyperVStopMode = 'shutdown' | 'turnoff'

export type GuestVmController = {
  create: (input: CreateGuestVmInput) => Promise<string>
  remove: (vmName: string) => Promise<void>
  start: (vmName: string) => Promise<void>
  stop: (vmName: string, mode: HyperVStopMode) => Promise<void>
}

const readVmId = (output: string): string => {
  // The create script prints one JSON object and nothing else, so a VM id is
  // never scraped out of prose that a localized Windows would translate.
  let parsed: unknown
  try {
    parsed = JSON.parse(output.trim())
  } catch {
    throw new WorkspacePathError('The executor guest VM was not created: its identity was not reported.')
  }
  const vmId = (parsed as { vmId?: unknown }).vmId
  if (typeof vmId !== 'string' || !VM_ID.test(vmId)) {
    throw new WorkspacePathError('The executor guest VM reported an invalid identity.')
  }
  return vmId.toLowerCase()
}

export const createGuestVmController = (input: {
  powerShellPath: string
  run: HyperVProcessRunner
  scripts: PinnedScriptStore
}): GuestVmController => {
  const invoke = async (
    name: Parameters<PinnedScriptStore['resolve']>[0],
    parameters: PowerShellParameters,
    timeoutMs: number,
  ): Promise<string> => input.run({
    argv: powerShellArgv(await input.scripts.resolve(name), parameters),
    path: input.powerShellPath,
    timeoutMs,
  })
  return {
    create: async (request) => readVmId(await invoke(
      'create.ps1',
      createGuestVmParameters(request),
      HYPERV_CREATE_TIMEOUT_MS,
    )),
    remove: async (vmName) => {
      await invoke('remove.ps1', [['VmName', vmName]], HYPERV_CONTROL_TIMEOUT_MS)
    },
    start: async (vmName) => {
      await invoke('start.ps1', [['VmName', vmName]], HYPERV_CONTROL_TIMEOUT_MS)
    },
    // `Stop-VM` with no switch, and with `-Force`, both ask the *guest* to shut
    // itself down through the shutdown integration service — `-Force` only
    // stops waiting for applications to save. This guest is an initramfs with
    // no integration services at all, so that request has nobody to answer it:
    // the graceful path is closing the control channel, exactly as under
    // Firecracker, and `-TurnOff` ("equivalent to disconnecting the power") is
    // what the timeout falls to. `shutdown` stays available because a future
    // guest that does run hv_utils should be asked politely first.
    stop: async (vmName, mode) => {
      await invoke('stop.ps1', [['VmName', vmName], ['Mode', mode]], HYPERV_CONTROL_TIMEOUT_MS)
    },
  }
}

/** The SCSI locations the create script must attach, stated once for its test. */
export const guestVmDiskLocations = (
  disks: HyperVGuestDisks,
): ReadonlyArray<{ controllerLocation: number; path: string }> => [
  { controllerLocation: GUEST_BOOT_CONTROLLER_LOCATION, path: disks.bootVhdPath },
  ...GUEST_SCSI_ATTACH_ORDER.map((entry) => ({
    controllerLocation: entry.controllerLocation,
    path: entry.driveId === 'runtime'
      ? disks.runtimeVhdPath
      : entry.driveId === 'workspace' ? disks.workspaceVhdPath : disks.draftVhdPath,
  })),
]

export const guestVmName = (sessionId: string, prefix: string): string =>
  `${prefix}${assertHyperVSessionId(sessionId)}`
