import { spawn, type ChildProcess } from 'node:child_process'

import { stopChildProcess } from '../guest-vm-backend.js'
import { WorkspacePathError } from '../workspace-paths.js'
import { hyperVPipePath } from './layout.js'
import { VM_ID } from './vm.js'

/**
 * `nessie-hyperv-bridge.exe`, one process per guest channel.
 *
 * Node has no `AF_HYPERV` and there is no way to add one from JavaScript, so a
 * small Rust binary owns the two ends: it listens on the VM's Hyper-V socket
 * for the service GUID that *is* the guest's vsock port, and forwards every
 * accepted connection to the named pipe the daemon is already listening on.
 * Both of Nessie's channels are guest-initiated, exactly as under Firecracker,
 * so `guest-to-host` is the only direction a session uses.
 *
 * It is spawned by the daemon, not by the Windows service: the pipes belong to
 * the account the daemon runs as, the bridge must be able to open them, and a
 * process the daemon started dies with the session it belongs to. The service
 * needs to make no call of its own.
 */
export type HyperVBridgeDirection = 'guest-to-host' | 'host-to-guest'

export type HyperVBridgeSpawner = (path: string, argv: string[]) => ChildProcess

const spawnBridgeProcess: HyperVBridgeSpawner = (path, argv) =>
  // argv is a list, never a shell string, and carries no secret: the VM id and
  // the port are both public facts about this session.
  spawn(path, argv, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })

export const bridgeArgv = (input: {
  direction: HyperVBridgeDirection
  pipePrefix: string
  port: number
  vmId: string
}): string[] => {
  if (!VM_ID.test(input.vmId)) {
    throw new WorkspacePathError('The executor guest VM identity is invalid.')
  }
  return [
    '--vm-id', input.vmId,
    '--port', String(input.port),
    '--pipe', hyperVPipePath(input.pipePrefix, input.port),
    '--direction', input.direction,
  ]
}

export type HyperVBridge = { close: () => Promise<void> }

export const startHyperVBridges = (input: {
  bridgePath: string
  pipePrefix: string
  ports: readonly number[]
  spawnProcess?: HyperVBridgeSpawner
  vmId: string
}): HyperVBridge => {
  const spawnProcess = input.spawnProcess ?? spawnBridgeProcess
  const children = input.ports.map((port) => spawnProcess(input.bridgePath, bridgeArgv({
    direction: 'guest-to-host',
    pipePrefix: input.pipePrefix,
    port,
    vmId: input.vmId,
  })))
  return {
    close: async () => {
      for (const child of children) await stopChildProcess(child).catch(() => undefined)
    },
  }
}
