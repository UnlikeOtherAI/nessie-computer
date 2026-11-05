import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertExecutorEgressOrigin,
  compileExecutorEgressPolicy,
  type ExecutorEgressPolicy,
} from './egress-policy.js'
import { startExecutorEgressGateway } from './egress-gateway.js'
import { createFirecrackerBackend } from './firecracker/index.js'
import { createHyperVBackend, hyperVSessionBootArgs } from './hyperv/index.js'
import {
  ingestGuestDrafts,
  registerSandboxDraftSource,
  releaseSandboxDraftSource,
  type SandboxDraftFlush,
} from './guest-draft-ingest.js'
import {
  GUEST_VM_RESOURCES,
  newGuestVmSessionId,
  selectGuestVmBackend,
  type ActiveGuestVmSessionProcess,
  type GuestVmBackendDependencies,
} from './guest-vm-backend.js'
import {
  GUEST_VM_BUILD_TIMEOUT_MS,
  GUEST_VM_HANDSHAKE_TIMEOUT_MS,
  runGuestVmProcess,
  secureGuestVmGatewayDirectory,
  secureGuestVmSessionDirectory,
  verifyPrivateCodexAuthProfile,
  type GuestVmProcessRunner,
  verifyPrivateGuestVmFile,
} from './guest-vm-artifacts.js'
import type {
  GuestBrowserAction,
  GuestBrowserActionResult,
  GuestBrowserObservation,
  GuestCodingAgent,
  GuestCodingObservation,
  GuestCommandRequest,
  GuestCommandResult,
  GuestRuntimeInspection,
} from './guest-vm-control.js'
import {
  materializeGuestRuntimeBundle,
  removeGuestRuntimeBundleSnapshot,
  verifyGuestRuntimeBundle,
} from './guest-runtime-bundle.js'
import {
  assertGuestWorkspaceLeaseCurrent,
  releaseGuestWorkspaceLease,
  type GuestWorkspaceLease,
} from './guest-workspace-lease.js'
import { detectExecutorHost, type ExecutorHost } from './host-platform.js'
import { WorkspacePathError } from './workspace-paths.js'

/**
 * What booting a guest needs on every host: the three owner-private artifacts,
 * the COW workspace lease the boot is bound to, and the state directory that
 * lease lives in. The hypervisor is not among them — it is chosen from the
 * host's own sandbox fact by `selectGuestVmBackend`.
 */
export type GuestVmBootInput = {
  guestInitrdBuilderPath: string
  kernelPath: string
  lease: GuestWorkspaceLease
  stateDir: string
  vmHelperPath: string
}

export type GuestVmSessionInput = GuestVmBootInput & {
  codexAuthProfilePath?: string
  /** Omit egress entirely for a network-disabled command session. */
  egressPolicy?: ExecutorEgressPolicy
  guestRuntimeBundlePath: string
}

export type GuestVmSession = {
  actBrowser: (action: GuestBrowserAction) => Promise<GuestBrowserActionResult>
  closed: Promise<void>
  closeCodingSession: () => Promise<void>
  inspectRuntime: () => Promise<GuestRuntimeInspection>
  launchCodingSession: (agent: GuestCodingAgent, prompt: string) => Promise<void>
  observeCodingSession: () => Promise<GuestCodingObservation>
  observeBrowser: (includeScreenshot?: boolean) => Promise<GuestBrowserObservation>
  openBrowser: (url: string) => Promise<void>
  runCommand: (request: GuestCommandRequest) => Promise<GuestCommandResult>
  stop: () => Promise<void>
}

export type GuestVmSessionDependencies = GuestVmBackendDependencies & {
  /** Injected in tests; production reads the real host. */
  host?: ExecutorHost
  runProcess?: GuestVmProcessRunner
}

/**
 * Starts one lease-bound guest VM and its owner-only forced-egress gateway.
 * Everything above this point — the artifact checks, the COW lease, the initrd
 * build, the runtime snapshot, the egress gateway, and the guest protocol — is
 * shared by every host. Only the hypervisor differs, and that difference is
 * confined to the backend chosen from the host's own sandbox fact.
 */
export const startGuestVmSession = async (
  input: GuestVmSessionInput,
  dependencies: GuestVmSessionDependencies = {},
): Promise<GuestVmSession> => {
  const backend = selectGuestVmBackend(
    dependencies.host ?? detectExecutorHost(),
    dependencies,
    () => createFirecrackerBackend(),
    () => createHyperVBackend(),
  )
  const egressSettings = input.egressPolicy
    ? compileExecutorEgressPolicy(input.egressPolicy)
    : undefined
  await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
  const [builderPath, kernelPath, helperPath, codexAuthProfilePath] = await Promise.all([
    verifyPrivateGuestVmFile(input.guestInitrdBuilderPath, true),
    verifyPrivateGuestVmFile(input.kernelPath, false),
    verifyPrivateGuestVmFile(input.vmHelperPath, true),
    input.codexAuthProfilePath
      ? verifyPrivateCodexAuthProfile(input.codexAuthProfilePath)
      : Promise.resolve(undefined),
  ])
  const runtimeBundle = await verifyGuestRuntimeBundle(input.guestRuntimeBundlePath)
  const sessionDirectory = await secureGuestVmSessionDirectory(input.stateDir, input.lease)
  const initrdPath = join(sessionDirectory, 'guest-initrd')
  const consolePath = join(sessionDirectory, 'console')
  const gatewayDirectory = input.egressPolicy
    ? await secureGuestVmGatewayDirectory()
    : undefined
  const gatewayPath = gatewayDirectory ? join(gatewayDirectory, 'egress.sock') : undefined
  const bootstrapToken = randomBytes(32).toString('base64url')
  const runProcess = dependencies.runProcess ?? runGuestVmProcess
  let process: ActiveGuestVmSessionProcess | undefined
  let draftFlush: SandboxDraftFlush | undefined
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    if (draftFlush) releaseSandboxDraftSource(input.lease.runId, draftFlush)
    await gateway?.close().catch(() => undefined)
    await removeGuestRuntimeBundleSnapshot(join(sessionDirectory, 'runtime')).catch(() => undefined)
    await rm(sessionDirectory, { force: true, recursive: true })
    if (gatewayDirectory) await rm(gatewayDirectory, { force: true, recursive: true })
    await releaseGuestWorkspaceLease(input.stateDir, input.lease).catch(() => undefined)
  }
  let gateway: Awaited<ReturnType<typeof startExecutorEgressGateway>> | undefined
  try {
    const runtimeSnapshot = await materializeGuestRuntimeBundle(runtimeBundle, join(sessionDirectory, 'runtime'))
    if (input.egressPolicy && gatewayPath) {
      gateway = await startExecutorEgressGateway({ policy: input.egressPolicy, socketPath: gatewayPath })
    }
    await runProcess({
      argv: [
        '--output', initrdPath,
        ...(codexAuthProfilePath ? ['--codex-auth', codexAuthProfilePath] : []),
        // Hyper-V's generation 2 firmware supplies no UEFI load options, so a
        // guest booted there has only the command line compiled into its
        // kernel. This session's own arguments travel in the initrd instead;
        // every other backend writes them onto the real command line and asks
        // for none here.
        ...(backend.kind === 'hyperv'
          ? ['--boot-args', hyperVSessionBootArgs({
            egress: Boolean(gateway),
            runtimeManifestDigest: runtimeSnapshot.manifestDigest,
          })]
          : []),
        '--bootstrap-token-stdin',
      ],
      input: bootstrapToken,
      path: builderPath,
      timeoutMs: GUEST_VM_BUILD_TIMEOUT_MS,
    })
    await assertGuestWorkspaceLeaseCurrent(input.stateDir, input.lease)
    process = await backend.start({
      bootstrapToken,
      consolePath,
      ...(gateway ? { egressGatewaySocketPath: gateway.socketPath } : {}),
      initrdPath,
      kernelPath,
      readyTimeoutMs: GUEST_VM_HANDSHAKE_TIMEOUT_MS,
      resources: GUEST_VM_RESOURCES,
      runtimeManifestDigest: runtimeSnapshot.manifestDigest,
      runtimeSnapshotPath: runtimeSnapshot.root,
      sessionDirectory,
      sessionId: newGuestVmSessionId(),
      vmHelperPath: helperPath,
      workspacePath: input.lease.workspace,
    })
    const started = process
    // A backend whose shares are block images cannot let the host read the
    // draft, so it exposes the guest's own reader instead. Registering it is
    // what makes `workspace.review` and promotion see live work; draining it
    // before stop is what makes the draft survive the guest.
    if (started.readDraft && started.scanDrafts) {
      const reader = { readDraft: started.readDraft, scanDrafts: started.scanDrafts }
      let draining: Promise<void> | undefined
      draftFlush = () => {
        draining = (draining ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => { await ingestGuestDrafts(reader, input.lease.workspace) })
        return draining
      }
      registerSandboxDraftSource(input.lease.runId, draftFlush)
    }
    const closed = process.closed.finally(cleanup)
    return {
      actBrowser: (action) => process!.actBrowser(action),
      closed,
      closeCodingSession: () => process!.closeCodingSession(),
      inspectRuntime: () => process!.inspectRuntime(),
      launchCodingSession: (agent, prompt) => process!.launchCodingSession(agent, prompt),
      observeCodingSession: () => process!.observeCodingSession(),
      observeBrowser: (includeScreenshot) => process!.observeBrowser(includeScreenshot),
      openBrowser: async (url: string) => {
        if (!egressSettings) throw new WorkspacePathError('This executor session has no browser egress.')
        assertExecutorEgressOrigin(url, egressSettings)
        await process!.openBrowser(url)
      },
      runCommand: (request) => process!.runCommand(request),
      stop: async () => {
        // The draft is drained while the guest is still answering. A failure
        // here must not leave a running VM behind, so it is recorded by the
        // caller's own review rather than blocking teardown.
        await draftFlush?.().catch(() => undefined)
        await process?.stop()
        await closed
      },
    }
  } catch (error) {
    await process?.stop().catch(() => undefined)
    await cleanup()
    throw error
  }
}
