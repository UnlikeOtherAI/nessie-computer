import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import type { ExecutorSandboxBackend } from '@nessie/executor-protocol'

import { GuestVmControlClient } from './guest-vm-control.js'
import type { ExecutorHost } from './host-platform.js'
import { WorkspacePathError } from './workspace-paths.js'

/**
 * The host-side view of one running guest. Every backend produces exactly this
 * shape, so the session code above it never learns which hypervisor booted the
 * VM: the guest protocol, not the hypervisor, is the contract.
 */
export type ActiveGuestVmSessionProcess = {
  actBrowser: GuestVmControlClient['actBrowser']
  closed: Promise<void>
  closeCodingSession: GuestVmControlClient['closeCodingSession']
  inspectRuntime: GuestVmControlClient['inspectRuntime']
  launchCodingSession: GuestVmControlClient['launchCodingSession']
  observeCodingSession: GuestVmControlClient['observeCodingSession']
  observeBrowser: GuestVmControlClient['observeBrowser']
  openBrowser: GuestVmControlClient['openBrowser']
  /**
   * Present only where the workspace reaches the guest as a block image the
   * host cannot read. Under virtiofs the guest writes straight into the host's
   * overlay directory, so there is nothing to stream back and the session must
   * not pretend otherwise — its absence is the fact that the share is a share.
   */
  readDraft?: GuestVmControlClient['readDraft']
  runCommand: GuestVmControlClient['runCommand']
  scanDrafts?: GuestVmControlClient['scanDrafts']
  stop: () => Promise<void>
}

/**
 * The macOS helper's own defaults (executor/vm VMConfiguration validates
 * 1–4 vCPUs and 2048–8192 MiB). Firecracker has no defaults of its own —
 * `PUT /machine-config` requires both fields — so the numbers live here, once,
 * rather than in each backend.
 */
export const GUEST_VM_RESOURCES: GuestVmResourceLimits = { memoryMiB: 4_096, vcpuCount: 2 }

/**
 * A session id is part of a Unix socket path, so it is deliberately shorter
 * than a UUID: 16 hex characters is 64 bits of collision resistance across the
 * handful of sessions one computer ever runs at once, and 20 fewer characters
 * of `sun_path`.
 */
export const GUEST_VM_SESSION_ID_MAX_CHARS = 16

export const newGuestVmSessionId = (): string => randomBytes(8).toString('hex')

export type GuestVmResourceLimits = {
  memoryMiB: number
  vcpuCount: number
}

export type GuestVmBackendStartInput = {
  /** One-use token the guest presents on its control hello; never in argv. */
  bootstrapToken: string
  consolePath: string
  /** Absent for a command session, which is deliberately network-disabled. */
  egressGatewaySocketPath?: string
  initrdPath: string
  kernelPath: string
  readyTimeoutMs: number
  resources: GuestVmResourceLimits
  runtimeManifestDigest: string
  runtimeSnapshotPath: string
  /** Owner-only per-session scratch directory; a backend may nest inside it. */
  sessionDirectory: string
  /** Unique per session; socket paths and the micro-VM id derive from it. */
  sessionId: string
  /** The hypervisor front-end: the Swift helper on macOS, Firecracker on Linux. */
  vmHelperPath: string
  workspacePath: string
}

export type GuestVmBackend = {
  readonly kind: ExecutorSandboxBackend
  start: (input: GuestVmBackendStartInput) => Promise<ActiveGuestVmSessionProcess>
}

/** The macOS helper is driven entirely through argv plus one stdin token. */
export type GuestVmSessionLauncher = (input: {
  argv: string[]
  input: string
  path: string
  readyTimeoutMs: number
}) => Promise<ActiveGuestVmSessionProcess>

const SESSION_STOP_TIMEOUT_MS = 10_000

export const waitForChildExit = (child: ChildProcess): Promise<void> => new Promise((resolvePromise) => {
  child.once('error', () => resolvePromise())
  child.once('exit', () => resolvePromise())
})

/** SIGTERM, then SIGKILL once the grace window has passed. */
export const stopChildProcess = async (
  child: ChildProcess,
  timeoutMs = SESSION_STOP_TIMEOUT_MS,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = waitForChildExit(child)
  child.kill('SIGTERM')
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    exited,
    new Promise<void>((resolvePromise) => {
      timeout = setTimeout(resolvePromise, timeoutMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

/** Binds a ready control client to the session shape callers hold. */
export const guestVmSessionProcess = (
  control: GuestVmControlClient,
  input: { closed: Promise<void>; stop: () => Promise<void> },
): ActiveGuestVmSessionProcess => ({
  actBrowser: (action) => control.actBrowser(action),
  closed: input.closed,
  closeCodingSession: () => control.closeCodingSession(),
  inspectRuntime: () => control.inspectRuntime(),
  launchCodingSession: (agent, prompt) => control.launchCodingSession(agent, prompt),
  observeCodingSession: () => control.observeCodingSession(),
  observeBrowser: (includeScreenshot) => control.observeBrowser(includeScreenshot),
  openBrowser: (url) => control.openBrowser(url),
  runCommand: (request) => control.runCommand(request),
  stop: input.stop,
})

const launchGuestVmHelper: GuestVmSessionLauncher = async ({ argv, input, path, readyTimeoutMs }) => {
  const child = spawn(path, argv, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  if (!child.stdin || !child.stdout) throw new WorkspacePathError('The executor VM helper is unavailable.')
  const control = new GuestVmControlClient(child.stdin, child.stdout)
  const closed = waitForChildExit(child).finally(() => control.close())
  try {
    child.stdin.write(input)
    await control.waitForReady(readyTimeoutMs)
  } catch (error) {
    await stopChildProcess(child)
    throw error
  }
  return guestVmSessionProcess(control, { closed, stop: () => stopChildProcess(child) })
}

/**
 * macOS: one Virtualization.framework micro-VM per session, driven by the
 * signed Swift helper. The helper owns the virtio-socket listeners and relays
 * the guest's control frames over its own stdin/stdout, so the whole
 * configuration is argv. Resource limits are deliberately NOT forwarded — the
 * helper's own defaults are `GUEST_VM_RESOURCES`, and adding the flags would
 * change an argv that is already the shipped contract.
 */
export const createVirtualizationFrameworkBackend = (
  dependencies: { launchProcess?: GuestVmSessionLauncher } = {},
): GuestVmBackend => {
  const launchProcess = dependencies.launchProcess ?? launchGuestVmHelper
  return {
    kind: 'virtualization_framework',
    start: (input) => launchProcess({
      argv: [
        'session',
        '--console', input.consolePath,
        '--kernel', input.kernelPath,
        '--initrd', input.initrdPath,
        '--workspace-cow', input.workspacePath,
        '--runtime-bundle', input.runtimeSnapshotPath,
        '--runtime-manifest-digest', input.runtimeManifestDigest,
        ...(input.egressGatewaySocketPath ? ['--egress-gateway', input.egressGatewaySocketPath] : []),
        '--bootstrap-token-stdin',
      ],
      input: input.bootstrapToken,
      path: input.vmHelperPath,
      readyTimeoutMs: input.readyTimeoutMs,
    }),
  }
}

export type GuestVmBackendDependencies = {
  backend?: GuestVmBackend
  /** The macOS helper launcher; injected by the existing session tests. */
  launchProcess?: GuestVmSessionLauncher
}

/**
 * Picks the backend from the host's own sandbox fact. `none` cannot reach a
 * session — the descriptor already restricts such a host to the workspace
 * bundle — but the seam refuses in words rather than assuming that upstream
 * gate held, and names the remedy the availability card names.
 */
export const selectGuestVmBackend = (
  host: ExecutorHost,
  dependencies: GuestVmBackendDependencies = {},
  createFirecracker?: () => GuestVmBackend,
  createHyperV?: () => GuestVmBackend,
): GuestVmBackend => {
  if (dependencies.backend) return dependencies.backend
  if (host.sandboxBackend === 'virtualization_framework') {
    return createVirtualizationFrameworkBackend(dependencies)
  }
  if (host.sandboxBackend === 'firecracker') {
    if (!createFirecracker) throw new WorkspacePathError('The executor Firecracker backend is unavailable.')
    return createFirecracker()
  }
  if (host.sandboxBackend === 'hyperv') {
    if (!createHyperV) throw new WorkspacePathError('The executor Hyper-V backend is unavailable.')
    return createHyperV()
  }
  throw new WorkspacePathError(
    'This computer reports no sandbox backend, so a guest VM session cannot start. '
    + 'Sandboxed commands, browsers, and coding sessions need hardware virtualization.',
  )
}
