import { z } from 'zod'

/**
 * The host facts a signed executor descriptor states about the machine it runs
 * on. They live beside `executor.ts` rather than inside it because that file is
 * already at its size ceiling, and because the API, the companion's host
 * detection, and the executor record presenter all need exactly these values
 * and nothing else from the descriptor.
 */
export const ExecutorOperatingSystemSchema = z.enum(['macos', 'linux', 'windows'])
export type ExecutorOperatingSystem = z.infer<typeof ExecutorOperatingSystemSchema>

export const ExecutorArchitectureSchema = z.enum(['arm64', 'x64'])
export type ExecutorArchitecture = z.infer<typeof ExecutorArchitectureSchema>

/**
 * Who keeps the daemon alive. An executor id has exactly one supervisor: the
 * desktop app that packages the companion, or the standalone service package
 * that starts at boot and survives logout. The two use different state roots,
 * so the fact is stable for the life of the pairing and decides which controls
 * a person is offered.
 */
export const ExecutorSupervisorSchema = z.enum(['desktop', 'service'])
export type ExecutorSupervisor = z.infer<typeof ExecutorSupervisorSchema>

/**
 * The per-session guest the host can actually start. `none` is a truthful
 * answer, not a failure: such a host still pairs and advertises the
 * copy-on-write workspace bundle, which needs no guest.
 */
export const ExecutorSandboxBackendSchema = z.enum([
  'virtualization_framework',
  'firecracker',
  'hyperv',
  'none',
])
export type ExecutorSandboxBackend = z.infer<typeof ExecutorSandboxBackendSchema>

/**
 * `osMajorVersion` is the one integer each platform publishes as its own
 * identity: the macOS major release, the Linux kernel major, and the Windows
 * build number. A single field keeps the signed descriptor small; the meaning
 * is fixed per `os`, so no reader has to guess.
 */
export const EXECUTOR_MINIMUM_OS_MAJOR_VERSIONS: Readonly<
  Record<ExecutorOperatingSystem, number>
> = {
  // Virtualization.framework's per-session guest contract.
  macos: 15,
  // Kernel 5 is the floor for the Firecracker/KVM vsock contract; the
  // descriptor carries only the major, so 5.10 is expressed as 5 here and the
  // packaged guest artifacts refuse an older point release.
  linux: 5,
  // Windows 10 22H2 (build 19045) is the oldest supported build.
  windows: 19045,
}

export const EXECUTOR_OS_VERSION_REQUIREMENTS =
  'Executor hosts require macOS 15+, Linux kernel 5+, or Windows build 19045+.'

export const ExecutorPlatformSchema = z
  .object({
    architecture: ExecutorArchitectureSchema,
    os: ExecutorOperatingSystemSchema,
    osMajorVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (platform) => platform.osMajorVersion >= EXECUTOR_MINIMUM_OS_MAJOR_VERSIONS[platform.os],
    { message: EXECUTOR_OS_VERSION_REQUIREMENTS, path: ['osMajorVersion'] },
  )
export type ExecutorPlatform = z.infer<typeof ExecutorPlatformSchema>

/**
 * The subset of a reviewed descriptor an executor row keeps denormalized, so
 * the Executors page can name the host and its controls without loading and
 * re-parsing a capability revision.
 */
export const ExecutorPlatformFactsSchema = z
  .object({
    platform: ExecutorPlatformSchema,
    sandboxBackend: ExecutorSandboxBackendSchema,
    supervisor: ExecutorSupervisorSchema,
  })
  .strict()
export type ExecutorPlatformFacts = z.infer<typeof ExecutorPlatformFactsSchema>

/**
 * The copy-on-write workspace bundle: every operation the daemon serves from
 * its own scratch directory with no guest at all. A host whose sandbox backend
 * is `none` may advertise this and nothing else.
 */
export const EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS = [
  'file.list',
  'file.read',
  'file.write',
  'workspace.review',
  'sandbox.stop',
] as const

export const EXECUTOR_WORKSPACE_ONLY_PROFILES = ['workspace_sandbox'] as const

/**
 * Every operation a host with no sandbox backend may still advertise: the
 * copy-on-write workspace bundle, plus the two MCP proxy operations.
 *
 * The MCP pair belongs here because it never boots a guest — it speaks to a
 * server the host owner installed and the policy named. Gating it on a sandbox
 * backend would refuse the whole point of it on exactly the machine that has
 * the software: a Mac with no VM backend and Kelpie installed.
 */
export const EXECUTOR_NO_SANDBOX_OPERATION_KEYS = [
  ...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  'mcp.tools',
  'mcp.call',
] as const
