import {
  EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  ImplementedExecutorOperationKeySchema,
  type ExecutorSignedDescriptor,
} from '@nessie/executor-protocol'

import { pairEnrollment, type PairExecutorDependencies, type PairExecutorInput } from './pair-enrollment.js'
export type { PairExecutorInput } from './pair-enrollment.js'
import {
  configuredCommandAllowlist, localCommandPolicyOf, parseLocalCommandPolicy,
  type LocalCommandPolicy,
} from './command-policy.js'
import { websitesFor, type ExecutorConfigurationSettings } from './configuration-input.js'
import { planCodingSessions, type CodingSessionsRequest } from './coding-sessions-policy.js'
import { assertHostSupportsOperations, buildSignedDescriptor } from './descriptor.js'
import { compileExecutorEgressPolicy } from './egress-policy.js'
import { verifyPrivateCodexAuthProfile, verifyPrivateGuestVmFile } from './guest-vm-artifacts.js'
import { verifyGuestRuntimeBundle } from './guest-runtime-bundle.js'
import { detectExecutorHost, type ExecutorHost } from './host-platform.js'
import { discoverLocalApps } from './local-app-discovery.js'
import { composeLocalMcpServers, managedMcpOperations } from './local-mcp-apps.js'
import { localMcpPolicyOf, MCP_OPERATION_KEYS } from './mcp-policy.js'
import { executorLocalMcpServerNames, type ExecutorLocalMcpServer } from './mcp-servers.js'
import { verifyNativeHelperPath } from './native-helper.js'
import {
  saveExecutorState,
  type ExecutorBrowserSandboxConfig,
  type ExecutorCodexSandboxConfig,
  type ExecutorLocalState,
} from './state-store.js'
import {
  assertExecutorWorkspaceFolderName,
  assertExecutorWorkspaceFolders,
  executorWorkspaceFolderNames,
  type ExecutorWorkspaceFolder,
} from './workspace-folders.js'
import { configureWorkspaceFolderPath } from './workspace.js'
import { assertWorkspaceMayChange } from './workspace-retirement.js'

/**
 * Canonicalise every paired folder, then check the set as a whole. Both halves
 * matter: a folder is only accepted as a real, ordinary, link-free directory,
 * and the set is only accepted when no name repeats and no folder contains
 * another — two rules that can only be checked after canonicalisation, because
 * a symbolic link could otherwise hide a nesting the names deny.
 */
export const configureExecutorWorkspaceFolders = async (
  requested: readonly ExecutorWorkspaceFolder[],
): Promise<ExecutorWorkspaceFolder[]> => {
  for (const folder of requested) assertExecutorWorkspaceFolderName(folder.name)
  const folders = await Promise.all(requested.map(async (folder) => ({
    name: folder.name,
    path: await configureWorkspaceFolderPath(folder.path),
  })))
  assertExecutorWorkspaceFolders(folders)
  return folders
}

const sameWorkspaceFolders = (
  left: readonly ExecutorWorkspaceFolder[],
  right: readonly ExecutorWorkspaceFolder[],
): boolean => (
  left.length === right.length
  && left.every((folder, index) => folder.name === right[index]?.name && folder.path === right[index]?.path)
)

/** The daemon-owned copy-on-write bundle, named once in `@nessie/executor-protocol`. */
export const COW_WORKSPACE_OPERATION_KEYS = EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS

const PROMOTION_OPERATION_KEY = 'workspace.promote' as const
export const BROWSER_OPERATION_KEYS = ['browser.open', 'browser.observe', 'browser.act'] as const
// Do not advertise the connected-Chrome daemon backend until the API/worker
// proves an interactive owner-private run and records observation provenance.
// Keeping this deny here makes an incomplete control-plane integration inert.
const CONNECTED_BROWSER_OPERATION_KEYS = [
  'browser.connected.open',
  'browser.connected.observe',
  'browser.connected.act',
] as const
export const CODING_OPERATION_KEYS = ['coding.launch', 'coding.observe'] as const
export const COMMAND_OPERATION_KEY = 'command.run' as const

type GuestVmArtifactInput = {
  guestInitrdBuilderPath: string
  guestRuntimeBundlePath: string
  kernelPath: string
  vmHelperPath: string
}

type VerifiedGuestVmArtifacts = GuestVmArtifactInput & {
  runtime: Awaited<ReturnType<typeof verifyGuestRuntimeBundle>>
}

const verifyGuestVmArtifacts = async (
  input: GuestVmArtifactInput,
): Promise<VerifiedGuestVmArtifacts> => {
  const [guestInitrdBuilderPath, kernelPath, vmHelperPath, runtime] = await Promise.all([
    verifyPrivateGuestVmFile(input.guestInitrdBuilderPath, true),
    verifyPrivateGuestVmFile(input.kernelPath, false),
    verifyPrivateGuestVmFile(input.vmHelperPath, true),
    verifyGuestRuntimeBundle(input.guestRuntimeBundlePath),
  ])
  return {
    guestInitrdBuilderPath,
    guestRuntimeBundlePath: runtime.root,
    kernelPath,
    runtime,
    vmHelperPath,
  }
}

const initialLocalPolicy = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  // File writes land in daemon-owned COW scratch. No host promotion is present
  // until a person explicitly enables its separately verified helper policy.
  operationKeys: [...COW_WORKSPACE_OPERATION_KEYS],
  profiles: ['workspace_sandbox'],
  revision: 1,
}

const configuredOperationKeys = (
  requestedOperationKeys: string[],
  browserConfigured: boolean,
  codexConfigured: boolean,
  host: ExecutorHost,
  mcpServerCount: number,
): string[] => {
  const requested = new Set(requestedOperationKeys)
  if (requested.size === 0 || requested.size !== requestedOperationKeys.length) {
    throw new Error('Name one or more distinct operations this computer implements.')
  }
  if ([...requested].some((operationKey) => (
    !ImplementedExecutorOperationKeySchema.safeParse(operationKey).success
  ))) {
    throw new Error('Only implemented workspace, command, browser, and coding operations may be configured.')
  }
  if (CONNECTED_BROWSER_OPERATION_KEYS.some((operationKey) => requested.has(operationKey))) {
    throw new Error('Connected Chrome is not yet available until the private-run disclosure gate is installed.')
  }
  const requestedBrowserOperations = BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey))
  if (requestedBrowserOperations.length > 0 && requestedBrowserOperations.length !== BROWSER_OPERATION_KEYS.length) {
    throw new Error('browser.open, browser.observe, and browser.act must be enabled together.')
  }
  if (requestedBrowserOperations.length > 0 && !browserConfigured) {
    throw new Error('Configure the owner-only browser VM and allowed origins before enabling browser operations.')
  }
  if (requestedBrowserOperations.length > 0 && !requested.has('sandbox.stop')) {
    throw new Error('Browser operations require sandbox.stop.')
  }
  const requestedCodingOperations = CODING_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey))
  if (requestedCodingOperations.length > 0 && requestedCodingOperations.length !== CODING_OPERATION_KEYS.length) {
    throw new Error('coding.launch and coding.observe must be enabled together.')
  }
  if (requestedCodingOperations.length > 0 && !codexConfigured) {
    throw new Error('Configure the owner-only Codex VM and auth profile before enabling coding operations.')
  }
  if (requestedCodingOperations.length > 0 && (
    !requested.has('sandbox.stop') || !requested.has('workspace.review')
  )) {
    throw new Error('coding.launch and coding.observe require workspace.review and sandbox.stop.')
  }
  if (requested.has(COMMAND_OPERATION_KEY) && !browserConfigured) {
    throw new Error('Configure the owner-only guest VM before enabling command.run.')
  }
  if (requested.has(COMMAND_OPERATION_KEY) && (
    !requested.has('workspace.review') || !requested.has('sandbox.stop')
  )) {
    throw new Error('command.run requires workspace.review and sandbox.stop.')
  }
  const requestedMcpOperations = MCP_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey))
  if (requestedMcpOperations.length > 0 && requestedMcpOperations.length !== MCP_OPERATION_KEYS.length) {
    throw new Error('mcp.tools and mcp.call must be enabled together.')
  }
  // Same misconfiguration rule as command.run: with no named server, every
  // MCP operation would be refused at dispatch while the executor advertised
  // the capability.
  if (requestedMcpOperations.length > 0 && mcpServerCount === 0) {
    throw new Error('Name at least one local MCP server before enabling mcp.tools and mcp.call.')
  }
  const operationKeys = [
    ...COW_WORKSPACE_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...(requested.has(COMMAND_OPERATION_KEY) ? [COMMAND_OPERATION_KEY] : []),
    ...BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...CODING_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...(requested.has(PROMOTION_OPERATION_KEY) ? [PROMOTION_OPERATION_KEY] : []),
    ...MCP_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
  ]
  // The same refusal the descriptor build makes, raised here so a person
  // proposing a policy hears it now instead of at the next connect.
  assertHostSupportsOperations(host, operationKeys, profilesForOperationKeys(operationKeys))
  return operationKeys
}

const profilesForOperationKeys = (operationKeys: string[]): string[] =>
  operationKeys.some((operationKey) => CODING_OPERATION_KEYS.includes(
    operationKey as typeof CODING_OPERATION_KEYS[number],
  ))
    ? ['workspace_sandbox', 'coding_session']
    : ['workspace_sandbox']

/**
 * Update the companion's locally enforced policy. Promotion additionally needs
 * an owner-verified native helper. This deliberately does not submit a
 * descriptor: the next connection signs and reports the new capabilities.
 * Machine resource permissions remain owned by this local configuration.
 *
 * An omitted `commandAllowlist` keeps the permitted programs the policy already
 * names — a caller changing operations does not silently disarm the list — and
 * an empty one clears them, which `command.run` then refuses. `settings` carry
 * the local-apps policy and the websites; under the `installed` local-apps
 * policy discovery runs and the MCP operation pair follows the servers found.
 */
export const configureExecutorLocalPolicy = async (
  stateDir: string,
  state: ExecutorLocalState,
  requestedOperationKeys: string[],
  nativeHelperPath?: string,
  host: ExecutorHost = detectExecutorHost(),
  workspaceFolders: readonly ExecutorWorkspaceFolder[] = state.workspaceFolders,
  commandAllowlist?: readonly string[],
  // An omitted list keeps the named servers; an empty one removes them all,
  // which the operation check below then refuses while mcp.* stays enabled.
  // Discovered servers are never the owner's: discovery supplies them below.
  mcpServers: readonly ExecutorLocalMcpServer[] = state.mcpServers ?? [],
  // The built-in coding-sessions bridge is never a named server: the executor
  // generates its entry from this, and its power facts join the descriptor.
  codingSessions: CodingSessionsRequest = {},
  commandPolicy?: LocalCommandPolicy,
  settings: ExecutorConfigurationSettings = {},
): Promise<ExecutorLocalState> => {
  const mcpPolicy = settings.mcpPolicy ?? localMcpPolicyOf(state)
  const permittedPrograms = configuredCommandAllowlist(commandAllowlist ?? state.descriptor.commandAllowlist ?? [])
  const localRules = commandPolicy !== undefined ? parseLocalCommandPolicy(commandPolicy)
    : commandAllowlist !== undefined
      ? parseLocalCommandPolicy({ ...localCommandPolicyOf(state), mode: 'allowlist', allowlist: permittedPrograms })
      : localCommandPolicyOf(state)
  const canonicalWorkspaceFolders = sameWorkspaceFolders(workspaceFolders, state.workspaceFolders)
    ? state.workspaceFolders
    : await configureExecutorWorkspaceFolders(workspaceFolders)
  if (!sameWorkspaceFolders(canonicalWorkspaceFolders, state.workspaceFolders)) {
    await assertWorkspaceMayChange(stateDir)
  }
  const bridge = await planCodingSessions({
    ...codingSessions,
    current: { facts: state.descriptor.codingSessions, servers: state.mcpServers },
    mcpServers,
    stateDir,
    workspaceFolders: canonicalWorkspaceFolders,
  })
  const discovered = mcpPolicy.mode === 'installed' ? await (settings.discover ?? discoverLocalApps)() : []
  const namedMcpServers = composeLocalMcpServers(bridge.servers, discovered, mcpPolicy)
  const operationKeys = configuredOperationKeys(
    managedMcpOperations(requestedOperationKeys, mcpPolicy, namedMcpServers.length),
    Boolean(state.browserSandbox),
    Boolean(state.codexSandbox),
    host,
    namedMcpServers.length,
  )
  const helper = nativeHelperPath
    ? await verifyNativeHelperPath(nativeHelperPath)
    : state.nativeHelperPath
  if (operationKeys.includes(PROMOTION_OPERATION_KEY) && !helper) {
    throw new Error('workspace.promote requires an owner-only native helper path.')
  }
  await bridge.persist(operationKeys)
  const next: ExecutorLocalState = {
    ...state,
    ...(settings.allowedOrigins === undefined ? {} : websitesFor(state, settings.allowedOrigins)),
    commandPolicy: localRules,
    ...(settings.mcpPolicy || state.mcpPolicy ? { mcpPolicy } : {}),
    // Local edits migrate legacy command rules out of the public descriptor.
    // The server receives capability facts, never the machine's launch rules.
    descriptor: {
      ...(bridge.facts ? { codingSessions: bridge.facts } : {}),
      limits: state.descriptor.limits,
      ...(namedMcpServers.length > 0
        ? { mcpServers: executorLocalMcpServerNames(namedMcpServers) }
        : {}),
      operationKeys,
      profiles: profilesForOperationKeys(operationKeys),
      revision: state.descriptor.revision + 1,
      // Every proposed policy names its folders, including a single one. A
      // pairing that predates the field keeps its unnamed descriptor until a
      // person proposes something — which is this call, and which bumps the
      // revision, so the reviewer sees the names appear rather than the meaning
      // of an already-approved revision changing under them.
      workspaceFolders: executorWorkspaceFolderNames(canonicalWorkspaceFolders),
    },
    ...(namedMcpServers.length > 0 ? { mcpServers: namedMcpServers } : {}),
    workspaceFolders: [...canonicalWorkspaceFolders],
    ...(helper ? { nativeHelperPath: helper } : {}),
  }
  // A cleared set must leave no key behind on the spread state, the same
  // reason the descriptor is rebuilt field by field above.
  if (namedMcpServers.length === 0) delete next.mcpServers
  await saveExecutorState(stateDir, next, state)
  return next
}

export const configureExecutorBrowserSandbox = async (
  stateDir: string,
  state: ExecutorLocalState,
  input: {
    allowedOrigins: string[]
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    vmHelperPath: string
  },
  host: ExecutorHost = detectExecutorHost(),
): Promise<ExecutorLocalState> => {
  const egress = compileExecutorEgressPolicy({ allowedOrigins: input.allowedOrigins })
  const artifacts = await verifyGuestVmArtifacts(input)
  const { guestInitrdBuilderPath, kernelPath, vmHelperPath, runtime } = artifacts
  if (!runtime.entrypoints.browser) {
    throw new Error('The guest runtime bundle does not declare a browser entrypoint.')
  }
  const browserSandbox: ExecutorBrowserSandboxConfig = {
    allowedOrigins: [...egress.allowedOrigins].sort(),
    guestInitrdBuilderPath,
    guestRuntimeBundlePath: artifacts.guestRuntimeBundlePath,
    kernelPath,
    vmHelperPath,
  }
  const currentNonBrowserOperations = state.descriptor.operationKeys.filter(
    (operationKey) => !BROWSER_OPERATION_KEYS.includes(
      operationKey as typeof BROWSER_OPERATION_KEYS[number],
    ),
  )
  const operationKeys = configuredOperationKeys([...new Set([
    ...currentNonBrowserOperations,
    'sandbox.stop',
    ...BROWSER_OPERATION_KEYS,
  ])], true, Boolean(state.codexSandbox), host, state.mcpServers?.length ?? 0)
  const next: ExecutorLocalState = {
    ...state,
    browserSandbox,
    descriptor: {
      ...state.descriptor,
      operationKeys,
      profiles: profilesForOperationKeys(operationKeys),
      revision: state.descriptor.revision + 1,
    },
  }
  // The browser's own list now holds the websites; one chosen before it existed is replaced by it.
  delete next.allowedOrigins
  await saveExecutorState(stateDir, next, state)
  return next
}

/**
 * Stores one local Codex login source after verifying its file and the whole
 * guest runtime. A connect then submits the exact descriptor for normal human
 * review; this configuration alone never bypasses that review.
 */
export const configureExecutorCodexSandbox = async (
  stateDir: string,
  state: ExecutorLocalState,
  input: GuestVmArtifactInput & { codexAuthProfilePath: string },
  host: ExecutorHost = detectExecutorHost(),
): Promise<ExecutorLocalState> => {
  const [artifacts, codexAuthProfilePath] = await Promise.all([
    verifyGuestVmArtifacts(input),
    verifyPrivateCodexAuthProfile(input.codexAuthProfilePath),
  ])
  if (!artifacts.runtime.entrypoints.codex || !artifacts.runtime.entrypoints.tmux) {
    throw new Error('The guest runtime bundle must declare owner-pinned Codex and tmux entrypoints.')
  }
  const codexSandbox: ExecutorCodexSandboxConfig = {
    codexAuthProfilePath,
    guestInitrdBuilderPath: artifacts.guestInitrdBuilderPath,
    guestRuntimeBundlePath: artifacts.guestRuntimeBundlePath,
    kernelPath: artifacts.kernelPath,
    vmHelperPath: artifacts.vmHelperPath,
  }
  const currentNonCodingOperations = state.descriptor.operationKeys.filter(
    (operationKey) => !CODING_OPERATION_KEYS.includes(
      operationKey as typeof CODING_OPERATION_KEYS[number],
    ),
  )
  const operationKeys = configuredOperationKeys([...new Set([
    ...currentNonCodingOperations,
    'workspace.review',
    'sandbox.stop',
    ...CODING_OPERATION_KEYS,
  ])], Boolean(state.browserSandbox), true, host, state.mcpServers?.length ?? 0)
  const next: ExecutorLocalState = {
    ...state,
    codexSandbox,
    descriptor: {
      ...state.descriptor,
      operationKeys,
      profiles: profilesForOperationKeys(operationKeys),
      revision: state.descriptor.revision + 1,
    },
  }
  await saveExecutorState(stateDir, next, state)
  return next
}

export const pairExecutor = async (
  input: PairExecutorInput, dependencies?: PairExecutorDependencies,
): Promise<{ fingerprint: string }> => pairEnrollment(
  input, await configureExecutorWorkspaceFolders(input.workspaceFolders), initialLocalPolicy, dependencies,
)

export const signedDescriptorForState = (state: ExecutorLocalState): ExecutorSignedDescriptor =>
  buildSignedDescriptor(state.machinePrivateKey, state.descriptor)
