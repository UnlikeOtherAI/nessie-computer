import { z } from 'zod'
import { PersonalInferenceAuthoritySchema } from './personal-inference-authority.js'
import { CapabilityPurposeDescriptorSchema } from './capability-purpose.js'

import {
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  ExecutorCodingSessionSummarySchema,
  ExecutorMcpCallOwnerSchema,
} from './executor-coding-sessions.js'
import { RunIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * A paired executor can front MCP servers that are installed on its own host
 * and reachable from nowhere else — a browser automation server bound to
 * loopback, a tool that drives hardware on that desk. The control plane never
 * speaks to those servers: it names one in the reviewed local policy, and the
 * daemon proxies exactly two operations to it, `mcp.tools` and `mcp.call`.
 *
 * Only the *name* travels. How the daemon starts a server — its binary, its
 * arguments, its working directory — stays on the host for the same reason a
 * workspace folder's path does: a reviewer of an organisation-scoped executor
 * approves a capability, not somebody's disk layout.
 */

export const EXECUTOR_MCP_SERVER_NAME_MAXIMUM_LENGTH = 40
export const EXECUTOR_MCP_SERVER_MAXIMUM = 8

const RESERVED_MCP_SERVER_NAMES = ['.', '..'] as const

export const executorMcpServerNameIsLegal = (value: string): boolean => (
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)
  && value.length <= EXECUTOR_MCP_SERVER_NAME_MAXIMUM_LENGTH
  && !(RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(value)
)

export const ExecutorMcpServerNameSchema = z
  .string()
  .max(EXECUTOR_MCP_SERVER_NAME_MAXIMUM_LENGTH)
  .refine(
    executorMcpServerNameIsLegal,
    'An MCP server name is 1 to 40 lowercase letters, digits and interior hyphens.',
  )
export type ExecutorMcpServerName = z.infer<typeof ExecutorMcpServerNameSchema>

const distinctMcpServerNames = (values: readonly string[]): boolean =>
  new Set(values).size === values.length

/**
 * The MCP server names the reviewed policy exposes. Present exactly when the
 * policy names one; absent means this executor fronts no local MCP server and
 * refuses both operations, which is the fail-closed reading an empty array
 * could not express.
 */
export const ExecutorMcpServerNamesSchema = z
  .array(ExecutorMcpServerNameSchema)
  .min(1)
  .max(EXECUTOR_MCP_SERVER_MAXIMUM)
  .refine(distinctMcpServerNames, 'Each MCP server is named once.')

/**
 * Kelpie's CLI MCP server, the one local server this release knows how to
 * detect and describe by itself. Every other named server is opaque to the
 * control plane: it is a name, a tool catalog, and nothing more.
 */
export const EXECUTOR_KELPIE_MCP_SERVER_NAME = 'kelpie'

/* -------------------------------------------------------------------------- */
/* Operation arguments                                                         */
/* -------------------------------------------------------------------------- */

export const ExecutorMcpToolsArgumentsSchema = z
  .object({
    server: ExecutorMcpServerNameSchema,
    /** Opaque page cursor from a previous listing, when the catalog is paged. */
    cursor: z.string().max(1_024).optional(),
  })
  .strict()
export type ExecutorMcpToolsArguments = z.infer<typeof ExecutorMcpToolsArgumentsSchema>

/** MCP tool names are the server's own identifiers; bound, never interpreted. */
export const ExecutorMcpToolNameSchema = z.string().min(1).max(128)

export const ExecutorMcpCallArgumentsSchema = z
  .object({
    server: ExecutorMcpServerNameSchema,
    tool: ExecutorMcpToolNameSchema,
    /**
     * Passed through to the server untouched. The daemon validates the
     * envelope, never the tool's own argument grammar — that belongs to the
     * server, which is the only thing that knows it.
     */
    arguments: z.record(z.unknown()).optional(),
  })
  .strict()
export type ExecutorMcpCallArguments = z.infer<typeof ExecutorMcpCallArgumentsSchema>

/**
 * The whole `mcp.call` command payload. `args` is what the model asked for;
 * `runId` and `owner` are stamped by the worker and covered by the argument
 * digest. The daemon turns `owner` into the reserved `_meta['nessie/owner']`
 * of a call to the built-in coding-sessions bridge, and never forwards it to
 * any other server. Absent, the bridge refuses every session tool.
 */
export const ExecutorMcpCallPayloadSchema = z
  .object({
    args: ExecutorMcpCallArgumentsSchema,
    owner: ExecutorMcpCallOwnerSchema.optional(),
    /** Server-derived run authority carried beside model arguments, never inside them. */
    personalAuthority: PersonalInferenceAuthoritySchema.optional(),
    runId: RunIdSchema,
  })
  .strict()
export type ExecutorMcpCallPayload = z.infer<typeof ExecutorMcpCallPayloadSchema>

/** Discovery executes custom stdio programs, so it needs the same signed owner/run envelope. */
export const ExecutorMcpToolsPayloadSchema = ExecutorMcpCallPayloadSchema.extend({
  args: ExecutorMcpToolsArgumentsSchema,
})

/* -------------------------------------------------------------------------- */
/* Tool catalog                                                                */
/* -------------------------------------------------------------------------- */

export const ExecutorMcpToolSchema = z
  .object({
    name: ExecutorMcpToolNameSchema,
    description: z.string().max(4_096).optional(),
    /** The server's own JSON Schema for this tool, carried verbatim. */
    inputSchema: z.record(z.unknown()),
  })
  .strict()
export type ExecutorMcpTool = z.infer<typeof ExecutorMcpToolSchema>

export const EXECUTOR_MCP_TOOL_MAXIMUM = 512

export const ExecutorMcpToolCatalogSchema = z
  .object({
    server: ExecutorMcpServerNameSchema,
    serverVersion: z.string().max(64).optional(),
    purposeDescriptor: CapabilityPurposeDescriptorSchema.optional(),
    tools: z.array(ExecutorMcpToolSchema).max(EXECUTOR_MCP_TOOL_MAXIMUM),
    /**
     * `sha256:…` over the canonical catalog. The control plane re-reads a
     * catalog only when this changes, so a Kelpie upgrade that adds a tool is
     * noticed without shipping 145 schemas on every heartbeat.
     */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    nextCursor: z.string().max(1_024).optional(),
  })
  .strict()
export type ExecutorMcpToolCatalog = z.infer<typeof ExecutorMcpToolCatalogSchema>

/* -------------------------------------------------------------------------- */
/* Kelpie instance inventory                                                   */
/* -------------------------------------------------------------------------- */

export const KelpieDevicePlatformSchema = z.enum([
  'ios',
  'android',
  'macos',
  'linux',
  'windows',
])
export type KelpieDevicePlatform = z.infer<typeof KelpieDevicePlatformSchema>

export const KelpieRuntimeModeSchema = z.enum(['gui', 'headless'])

/**
 * One Kelpie browser found on the executor's network.
 *
 * Kelpie announces itself over mDNS and each instance picks its own port, so
 * neither an address nor a port is ever a constant: the inventory is what the
 * daemon last *observed*, stated with the moment it observed it, and a caller
 * that treats a stale entry as reachable is the caller's bug.
 *
 * Every field here comes from Kelpie's own announcement (its mDNS TXT record)
 * or its `/v1/get-device-info` reply, so the control plane learns what the
 * instance is, which version it runs, and which machine it is, without Nessie
 * ever guessing at a hostname.
 */
export const KelpieDeviceSchema = z
  .object({
    /** Kelpie's stable per-instance id, the handle its own tools take. */
    id: z.string().min(1).max(128),
    /** The machine's advertised name, e.g. "Ondrej's MacBook Pro". */
    name: z.string().min(1).max(128),
    /** Hardware model string, e.g. "iPhone 17 Pro" or "MacBookPro18,2". */
    model: z.string().max(128).optional(),
    platform: KelpieDevicePlatformSchema,
    runtimeMode: KelpieRuntimeModeSchema.optional(),
    /** The renderer this instance is running, e.g. "webkit" or "chromium". */
    engine: z.string().max(64).optional(),
    /** The Kelpie app/CLI version this instance reports. */
    version: z.string().max(64).optional(),
    /** Last observed address and port. Both move; neither is an identity. */
    address: z.string().min(1).max(64),
    port: z.number().int().min(1).max(65_535),
    display: z
      .object({
        width: z.number().int().min(0).max(100_000),
        height: z.number().int().min(0).max(100_000),
      })
      .strict()
      .optional(),
    /**
     * Whether this executor holds a pairing token for the instance. Kelpie
     * refuses every automation method until a person pairs on the device, so
     * an unpaired instance is discoverable and not yet drivable — two states a
     * single "online" flag would blur.
     */
    paired: z.boolean(),
    /** When the daemon last saw this instance announce or answer. */
    lastSeenAt: TimestampSchema,
  })
  .strict()
export type KelpieDevice = z.infer<typeof KelpieDeviceSchema>

export const EXECUTOR_KELPIE_DEVICE_MAXIMUM = 32

/* -------------------------------------------------------------------------- */
/* Availability report                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why a named server is not currently usable. Distinguishing these is the
 * whole point of the report: "Kelpie is not installed" and "Kelpie is
 * installed and no browser answered" lead a person to opposite actions.
 */
export const ExecutorMcpUnavailableReasonSchema = z.enum([
  'not_installed',
  'launch_failed',
  'handshake_failed',
  'unsupported_platform',
  'not_probed',
])
export type ExecutorMcpUnavailableReason = z.infer<
  typeof ExecutorMcpUnavailableReasonSchema
>

export const ExecutorLocalMcpStatusSchema = z
  .object({
    server: ExecutorMcpServerNameSchema,
    /** True exactly when the daemon completed an MCP handshake with it. */
    available: z.boolean(),
    reason: ExecutorMcpUnavailableReasonSchema.optional(),
    /** A short, person-readable explanation. Never a host path. */
    detail: z.string().max(512).optional(),
    serverVersion: z.string().max(64).optional(),
    toolCount: z.number().int().min(0).max(EXECUTOR_MCP_TOOL_MAXIMUM).optional(),
    catalogDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    /**
     * Present only for the `kelpie` server, which the daemon knows how to
     * enumerate. A Kelpie that is installed but has found no browser reports
     * an empty array; a server that was never probed for instances omits it.
     */
    kelpieDevices: z.array(KelpieDeviceSchema).max(EXECUTOR_KELPIE_DEVICE_MAXIMUM).optional(),
    /**
     * Present only for the built-in `coding-sessions` bridge: its open
     * sessions, newest first, without anything they said or did. Absent means
     * the bridge was not asked, never that it has none.
     */
    codingSessions: z
      .array(ExecutorCodingSessionSummarySchema)
      .max(EXECUTOR_CODING_SESSION_REPORT_MAXIMUM)
      .optional(),
    observedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (status) => status.codingSessions === undefined || status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
    'Only the coding-sessions bridge reports coding sessions.',
  )
export type ExecutorLocalMcpStatus = z.infer<typeof ExecutorLocalMcpStatusSchema>

/**
 * The whole local-MCP picture as of one heartbeat. An empty array is
 * meaningful: it says this daemon names no MCP server, which is different from
 * the field being absent, which says this daemon is too old to report at all.
 */
export const ExecutorLocalMcpReportSchema = z
  .array(ExecutorLocalMcpStatusSchema)
  .max(EXECUTOR_MCP_SERVER_MAXIMUM)
  .refine(
    (statuses) => distinctMcpServerNames(statuses.map((status) => status.server)),
    'Each MCP server reports once.',
  )
export type ExecutorLocalMcpReport = z.infer<typeof ExecutorLocalMcpReportSchema>
