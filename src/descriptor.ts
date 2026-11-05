import { createHash, createPrivateKey, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  EXECUTOR_NO_SANDBOX_OPERATION_KEYS,
  EXECUTOR_WORKSPACE_ONLY_PROFILES,
  ExecutorCapabilityDescriptorSchema,
  ImplementedExecutorOperationKeySchema,
  ExecutorSignedDescriptorSchema,
  type ExecutorCodingSessionsFacts,
  type ExecutorSignedDescriptor,
} from '@nessie/executor-protocol'

import { detectExecutorHost, sandboxRemedyForHost, type ExecutorHost } from './host-platform.js'

type LocalDescriptorConfig = {
  /**
   * What the built-in coding-sessions bridge may do, including the digest of
   * its host-local configuration. Part of the digest, so offering or widening
   * the bridge is a revision a person reviews; absent when it is not offered.
   */
  codingSessions?: ExecutorCodingSessionsFacts
  /** The programs `command.run` may start; absent until a policy names one. */
  commandAllowlist?: string[]
  limits: { maxCommandRuntimeSeconds: number; maxResultBytes: number; maxSessions: number }
  operationKeys: string[]
  profiles: string[]
  revision: number
  /**
   * The local MCP server names this policy fronts. The names are part of the
   * digest, so adding a server is a revision a person reviews — the launch
   * specs (argv, cwd, env) stay local and never reach Nessie.
   */
  mcpServers?: string[]
  /**
   * The workspace folder names this policy exposes; absent for a descriptor
   * signed before folders had names, which describes exactly one folder. The
   * names are part of the digest, so adding a folder is a revision a person
   * reviews — the host paths stay local and never reach Nessie.
   */
  workspaceFolders?: string[]
}

const runsWithoutSandbox = (operationKey: string): boolean =>
  (EXECUTOR_NO_SANDBOX_OPERATION_KEYS as readonly string[]).includes(operationKey)

const isWorkspaceOnlyProfile = (profile: string): boolean =>
  (EXECUTOR_WORKSPACE_ONLY_PROFILES as readonly string[]).includes(profile)

/**
 * A host with no sandbox backend is still a usable executor, but only for the
 * copy-on-write workspace bundle the daemon serves from its own scratch
 * directory. Everything else needs a per-session guest, so it is refused here
 * — at the moment a person proposes the policy — with the remedy named, rather
 * than advertised to the control plane and failed at the first command.
 */
export const assertHostSupportsOperations = (
  host: ExecutorHost,
  operationKeys: readonly string[],
  profiles: readonly string[],
): void => {
  if (host.sandboxBackend !== 'none') return
  const unsupported = [
    ...operationKeys.filter((operationKey) => !runsWithoutSandbox(operationKey)),
    ...profiles.filter((profile) => !isWorkspaceOnlyProfile(profile)),
  ]
  if (unsupported.length === 0) return
  throw new Error(
    `This computer has no sandbox backend, so it can offer only ${
      EXECUTOR_NO_SANDBOX_OPERATION_KEYS.join(', ')
    }. Refused: ${unsupported.join(', ')}. ${sandboxRemedyForHost(host)}`,
  )
}

const policyDigest = (config: LocalDescriptorConfig): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(config)).digest('hex')}`

export const buildSignedDescriptor = (
  privateKeyDer: string,
  config: LocalDescriptorConfig,
  host: ExecutorHost = detectExecutorHost(),
): ExecutorSignedDescriptor => {
  assertHostSupportsOperations(host, config.operationKeys, config.profiles)
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    // The list travels with the descriptor only when it says something: an
    // empty array would advertise a rule where the policy has none, and the
    // schema refuses it rather than letting the two readings blur.
    ...(config.commandAllowlist?.length ? { commandAllowlist: config.commandAllowlist } : {}),
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
    ...(config.codingSessions ? { codingSessions: config.codingSessions } : {}),
    ...(config.workspaceFolders?.length ? { workspaceFolders: config.workspaceFolders } : {}),
    limits: config.limits,
    localPolicyDigest: policyDigest(config),
    operationKeys: config.operationKeys.map((key) => ImplementedExecutorOperationKeySchema.parse(key)),
    platform: host.platform,
    profiles: config.profiles,
    protocolVersion: 1,
    revision: config.revision,
    sandboxBackend: host.sandboxBackend,
    supervisor: host.supervisor,
  })
  return ExecutorSignedDescriptorSchema.parse({
    descriptor,
    signature: sign(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor)),
      createPrivateKey({
        format: 'der',
        key: Buffer.from(privateKeyDer, 'base64url'),
        type: 'pkcs8',
      }),
    ).toString('base64url'),
  })
}
