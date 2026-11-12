import { z } from 'zod'
import { ExecutorSoftwareStatusSchema, ExecutorSoftwareUpdateRequestSchema } from './executor-updates.js'
import {
  EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM, ExecutorIMessageOutboxWireItemSchema, ExecutorIMessageReportSchema,
  ExecutorIMessageSwitchSchema,
} from './executor-imessage.js'
import { ExecutorMonitorRequestSchema, ExecutorMonitorSnapshotSchema } from './executor-monitor.js'
import { ExecutorCommandCancellationSchema, ExecutorCommandCancellationTargetSchema } from './executor-cancellation.js'
import {
  EXECUTOR_AGENT_NAME_MAX_CHARS,
  EXECUTOR_CONCURRENT_COMMANDS_MAXIMUM,
  ExecutorConcurrentPollAnswerFieldsSchema,
  ExecutorConcurrentPollFieldsSchema,
  ExecutorSessionIdSchema,
} from './executor-sessions.js'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  UserIdSchema,
} from './ids.js'
import {
  ExecutorPlatformFactsSchema,
  ExecutorPlatformSchema,
  ExecutorSandboxBackendSchema,
  ExecutorSupervisorSchema,
} from './executor-platform.js'
import {
  ExecutorLocalMcpReportSchema,
  ExecutorMcpServerNamesSchema,
} from './executor-mcp.js'
import {
  ExecutorCodingSessionCloseListSchema,
  ExecutorCodingSessionsFactsSchema,
} from './executor-coding-sessions.js'
import { CHAT_MESSAGE_MAX_CHARS } from './messaging.js'
import { ExecutorViewerAccessSchema } from './executor-sharing.js'
import { createUuidBrandSchema, TimestampSchema } from './schema-primitives.js'

export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
/**
 * How many operations one descriptor may advertise. It was 16 while the
 * catalog held 15; the two MCP proxy operations took it past that, so the cap
 * moved to leave the same headroom rather than to fit exactly.
 */
export const EXECUTOR_DESCRIPTOR_OPERATION_MAXIMUM = 24
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)
export const ExecutorDaemonSignatureSchema = Base64UrlSchema.min(64).max(256)
// The daemon challenge is a compact signed token: two base64url segments with
// one literal separator. It is intentionally distinct from a single
// base64url field so the API can return and accept the value it issues.
const ExecutorDaemonChallengeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  .min(64)
  .max(2048)
const NonEmptyRecordSchema = z.record(z.string(), z.unknown())

export const ExecutorIdSchema = createUuidBrandSchema<'ExecutorId'>()
export type ExecutorId = z.infer<typeof ExecutorIdSchema>

export const ExecutorEnrollmentIdSchema =
  createUuidBrandSchema<'ExecutorEnrollmentId'>()
export type ExecutorEnrollmentId = z.infer<typeof ExecutorEnrollmentIdSchema>

export const ExecutorBindingIdSchema = createUuidBrandSchema<'ExecutorBindingId'>()
export type ExecutorBindingId = z.infer<typeof ExecutorBindingIdSchema>

// The session a run's work on the computer belongs to (contract §11); its
// schema lives with the rest of the session wire contract.
export { ExecutorSessionIdSchema, type ExecutorSessionId } from './executor-sessions.js'

export const ExecutorCommandIdSchema = createUuidBrandSchema<'ExecutorCommandId'>()
export type ExecutorCommandId = z.infer<typeof ExecutorCommandIdSchema>

export const ExecutorAccessChangeIdSchema =
  createUuidBrandSchema<'ExecutorAccessChangeId'>()
export type ExecutorAccessChangeId = z.infer<typeof ExecutorAccessChangeIdSchema>

export const ExecutorWorkspacePromotionIdSchema =
  createUuidBrandSchema<'ExecutorWorkspacePromotionId'>()
export type ExecutorWorkspacePromotionId = z.infer<typeof ExecutorWorkspacePromotionIdSchema>

export const ExecutorScopeKindSchema = z.enum([
  'private',
  'project',
  'organization',
])
export type ExecutorScopeKind = z.infer<typeof ExecutorScopeKindSchema>

export const ExecutorScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('private'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('project'),
      organizationId: OrganizationIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('organization'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
])
export type ExecutorScope = z.infer<typeof ExecutorScopeSchema>

export const ExecutorStatusSchema = z.enum([
  'pending_pairing',
  'online',
  'offline',
  'paused',
  'draining',
  'revoked',
  'error',
])
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>

export const ExecutorProfileSchema = z.enum([
  'workspace_sandbox',
  'coding_session',
  // A separately fenced session for a person-approved tab in their own Chrome.
  // It must never be mistaken for the fresh-profile VM browser.
  'connected_browser',
])
export type ExecutorProfile = z.infer<typeof ExecutorProfileSchema>

export const ExecutorOperationKeySchema = z.enum([
  'file.list',
  'file.read',
  'file.write',
  'command.run',
  'browser.open',
  'browser.observe',
  'browser.act',
  'browser.connected.open',
  'browser.connected.observe',
  'browser.connected.act',
  'workspace.review',
  'workspace.promote',
  'sandbox.stop',
  'coding.launch',
  'coding.attach',
  'coding.observe',
  'coding.prompt',
  'coding.interrupt',
  'coding.close',
  // Two proxy operations onto an MCP server installed on the executor's own
  // host. They are a transport, not a capability: what they can do is whatever
  // the named server's own tools do, which is why the policy names servers
  // rather than granting a blanket "run local MCP".
  'mcp.tools',
  'mcp.call',
  // One iMessage through the Messages app on the owner's own Mac
  // (`executor-imessage.ts`). Only a macOS daemon advertises it.
  'imessage.send',
])
export type ExecutorOperationKey = z.infer<typeof ExecutorOperationKeySchema>

/**
 * The sole catalog of executor operations with a live daemon implementation.
 * `workspace.promote` stays here because its daemon path is real, although it
 * remains intentionally absent from the model-facing toolset: only a person
 * can issue a reviewed promotion.
 */
export const IMPLEMENTED_EXECUTOR_OPERATION_KEYS = [
  'file.list',
  'file.read',
  'file.write',
  'command.run',
  'browser.open',
  'browser.observe',
  'browser.act',
  // The daemon has a local implementation, but the control plane must not
  // advertise this bundle until it can prove the originating run is private
  // and attach the owner-only disclosure basis for every observation.
  'browser.connected.open',
  'browser.connected.observe',
  'browser.connected.act',
  'coding.launch',
  'coding.observe',
  'workspace.review',
  'workspace.promote',
  'sandbox.stop',
  'mcp.tools',
  'mcp.call',
  'imessage.send',
] as const satisfies readonly ExecutorOperationKey[]
export type ImplementedExecutorOperationKey =
  (typeof IMPLEMENTED_EXECUTOR_OPERATION_KEYS)[number]
export const ImplementedExecutorOperationKeySchema = z.enum(
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS,
)

/**
 * The operation a person alone may issue, and therefore the one operation a
 * whole-suite grant to an agent never contains.
 *
 * `workspace.promote` has a real daemon path, which is why it stays in the
 * implemented catalog — but it is deliberately absent from the model-facing
 * toolset: promoting a reviewed draft back onto somebody's host root is a
 * reviewed human act, not a capability an agent is handed with the rest.
 */
export const HUMAN_ONLY_EXECUTOR_OPERATION_KEYS = [
  'workspace.promote',
] as const satisfies readonly ImplementedExecutorOperationKey[]

/**
 * The whole suite an executor offers an agent: every operation key its ACTIVE
 * capability revision names, kept to the implemented catalog and minus the
 * human-only ones.
 *
 * An executor grant to an agent is whole-suite by construction. Deriving the
 * set here — from the revision a person reviewed — is what makes the rule
 * "if an agent has access to an executor, it has the whole suite available on
 * that executor" a property of the code rather than of whoever assembled the
 * list, and it is the same function the confirmation dialog enumerates from.
 */
export const executorWholeSuiteOperationKeys = (
  revisionOperationKeys: readonly string[],
): ImplementedExecutorOperationKey[] =>
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS.filter((key) =>
    revisionOperationKeys.includes(key)
    && !(HUMAN_ONLY_EXECUTOR_OPERATION_KEYS as readonly string[]).includes(key))

/** Arguments accepted by the first read-only workspace backend. */
export const ExecutorFileListArgumentsSchema = z
  .object({
    path: z.string().max(1_024).optional(),
    maxEntries: z.number().int().min(1).max(100).optional(),
  })
  .strict()
export type ExecutorFileListArguments = z.infer<typeof ExecutorFileListArgumentsSchema>

export const ExecutorFileReadArgumentsSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    // Eight KiB leaves room for JSON escaping inside the command's 64 KiB
    // terminal-result limit.
    maxBytes: z.number().int().min(1).max(8_192).optional(),
  })
  .strict()
export type ExecutorFileReadArguments = z.infer<typeof ExecutorFileReadArgumentsSchema>

/**
 * Writes are confined to the daemon-owned copy-on-write workspace. They can
 * never target the paired host root; promotion is a separate future operation.
 */
export const ExecutorFileWriteArgumentsSchema = z
  .object({
    content: z.string().max(65_536),
    createParents: z.boolean().optional(),
    overwrite: z.boolean().optional(),
    path: z.string().min(1).max(1_024),
  })
  .strict()
export type ExecutorFileWriteArguments = z.infer<typeof ExecutorFileWriteArgumentsSchema>

/** Browser navigation is limited to one locally approved HTTPS URL. */
export const ExecutorBrowserOpenArgumentsSchema = z
  .object({
    url: z.string().url().max(4_096),
  })
  .strict()
export type ExecutorBrowserOpenArguments = z.infer<typeof ExecutorBrowserOpenArgumentsSchema>

/**
 * Browser observation exposes a bounded accessibility snapshot to every model.
 * A screenshot remains opt-in because only vision-capable providers can use it.
 */
export const ExecutorBrowserObserveArgumentsSchema = z
  .object({
    includeScreenshot: z.boolean().optional(),
  })
  .strict()
export type ExecutorBrowserObserveArguments = z.infer<typeof ExecutorBrowserObserveArgumentsSchema>

const ExecutorBrowserNodeIdSchema = z.number().int().min(0).max(2_147_483_647)
const ExecutorBrowserKeySchema = z.enum([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
])

/**
 * Closed CDP actions addressed only by a backend accessibility node id emitted
 * from `browser.observe`. Selectors, scripts, and pixel coordinates are never
 * accepted from the model.
 */
export const ExecutorBrowserActArgumentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().url().max(4_096) }).strict(),
  z.object({ action: z.literal('click'), nodeId: ExecutorBrowserNodeIdSchema }).strict(),
  z.object({ action: z.literal('type'), nodeId: ExecutorBrowserNodeIdSchema, text: z.string().max(4_096) }).strict(),
  z.object({ action: z.literal('press'), key: ExecutorBrowserKeySchema }).strict(),
  z.object({ action: z.literal('scroll'), nodeId: ExecutorBrowserNodeIdSchema.optional(), deltaY: z.number().int().min(-10_000).max(10_000).refine((value) => value !== 0) }).strict(),
])
export type ExecutorBrowserActArguments = z.infer<typeof ExecutorBrowserActArgumentsSchema>

/**
 * A cloud browser tab, addressed only by the opaque handle `browser_tabs`
 * lists — never a CDP target id, which a model must not learn or forge.
 */
export const BrowserTabHandleSchema = z.string().regex(/^tab_[a-z0-9]{8}$/)

/** `browser_tabs`: the owner's own tabs in its own live browser. */
export const BrowserTabsArgumentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('open') }).strict(),
  z.object({ action: z.literal('select'), tab: BrowserTabHandleSchema }).strict(),
  z.object({ action: z.literal('close'), tab: BrowserTabHandleSchema }).strict(),
])
export type BrowserTabsArguments = z.infer<typeof BrowserTabsArgumentsSchema>

/**
 * Connected Chrome accepts the same closed verb grammar as the isolated
 * browser. In particular it never accepts a tab id, selector, DevTools method,
 * script, profile name, or an extension-provided capability.
 */
export const ExecutorConnectedBrowserOpenArgumentsSchema = ExecutorBrowserOpenArgumentsSchema
export type ExecutorConnectedBrowserOpenArguments = z.infer<typeof ExecutorConnectedBrowserOpenArgumentsSchema>
export const ExecutorConnectedBrowserObserveArgumentsSchema = ExecutorBrowserObserveArgumentsSchema
export type ExecutorConnectedBrowserObserveArguments = z.infer<typeof ExecutorConnectedBrowserObserveArgumentsSchema>
export const ExecutorConnectedBrowserActArgumentsSchema = ExecutorBrowserActArgumentsSchema
export type ExecutorConnectedBrowserActArguments = z.infer<typeof ExecutorConnectedBrowserActArgumentsSchema>

const commandString = (maximum: number) => z.string().max(maximum).refine(
  (value) => !value.includes('\u0000'),
  'NUL bytes are not valid command arguments.',
)
const commandProgram = z.string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\u0000'), 'NUL bytes are not valid command arguments.')
  .refine((value) => !value.includes('/'), 'program must resolve through the fixed guest PATH.')
  .refine(
    (value) => !['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'].includes(value),
    'Shell interpreters are not available to executor commands.',
  )
const commandArgumentBytes = (value: { args: string[]; cwd?: string; program: string }): number => (
  new TextEncoder().encode([value.program, value.cwd ?? '', ...value.args].join('\u0000')).byteLength
)
const relativeWorkspacePath = (value: string): boolean => (
  value === '.' || (
    !value.startsWith('/')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
)

const distinctExecutorWorkspaceFolderNames = (value: readonly string[]): boolean =>
  new Set(value).size === value.length

/**
 * How many host folders one executor may expose, and what a folder may be
 * called. The name is the first segment of every workspace path an agent
 * writes, so it is also a directory name in the daemon's copy-on-write layout
 * and a token in the audit trail.
 *
 * Lowercase ASCII, digits and interior hyphens only:
 *
 *  - lowercase-only makes case-insensitive distinctness structural rather than
 *    a check somebody can forget. Two folders differing only in case would be
 *    one directory on a case-insensitive filesystem, which is a trap.
 *  - no dot means `.` and `..` are unrepresentable, and so is the executor's
 *    own promotion journal directory.
 *  - a name starts and ends alphanumeric, so it never reads as a command-line
 *    flag and never leaves a trailing separator-adjacent hyphen.
 *  - one bounded ASCII token is byte-stable in a receipt: no locale, no case
 *    folding, no Unicode normalization can change what a reviewer approved.
 */
export const EXECUTOR_WORKSPACE_FOLDER_MAXIMUM = 16
export const EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH = 40
export const EXECUTOR_WORKSPACE_FOLDER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u

/**
 * Windows turns these basenames into devices wherever a path is opened, so a
 * folder may not be called one even on a host where it would work today: the
 * name travels with the reviewed policy, and the same policy has to be legal on
 * the next machine that loads it.
 */
export const EXECUTOR_RESERVED_WORKSPACE_FOLDER_NAMES = [
  'aux',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'con',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  'nul',
  'prn',
] as const

export const executorWorkspaceFolderNameIsLegal = (value: string): boolean => (
  EXECUTOR_WORKSPACE_FOLDER_NAME_PATTERN.test(value)
  && value.length <= EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH
  && !(EXECUTOR_RESERVED_WORKSPACE_FOLDER_NAMES as readonly string[]).includes(value)
)

export const ExecutorWorkspaceFolderNameSchema = z
  .string()
  .max(EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH)
  .refine(
    executorWorkspaceFolderNameIsLegal,
    'A workspace folder name is 1 to 40 lowercase letters, digits and interior hyphens.',
  )

/**
 * The folder names the reviewed policy exposes. Present exactly when the
 * executor names its folders — absent from every descriptor signed before this
 * field existed, which each describe exactly one folder. Carrying a synthesized
 * single name into those descriptors would change them at an unchanged
 * revision, and the control plane refuses that outright.
 */
export const ExecutorWorkspaceFolderNamesSchema = z
  .array(ExecutorWorkspaceFolderNameSchema)
  .min(1)
  .max(EXECUTOR_WORKSPACE_FOLDER_MAXIMUM)
  .refine(distinctExecutorWorkspaceFolderNames, 'Each workspace folder is named once.')

export const EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM = 64
export const EXECUTOR_COMMAND_PATTERN_MAXIMUM_LENGTH = 512
/** The final token that widens an entry to "and any further arguments". */
export const EXECUTOR_COMMAND_WILDCARD = '*'

/**
 * One permitted command, written the way a person would type it: a program,
 * then the arguments that must match, then an optional trailing `*` meaning
 * "and anything after this".
 *
 *   git *          every git command
 *   git status *   git status with any flags, but never git push
 *   npm run *      every script, but never npm publish
 *   node           node with no arguments at all
 *
 * The guest micro-VM bounds what a running command can reach; it says nothing
 * about which command runs. This is that second boundary, and it belongs to the
 * local policy so widening it costs a revision a person reviews.
 *
 * The program position is always a literal: a wildcard there would permit the
 * shells `commandProgram` deliberately refuses, so `*` alone — or `gi*` — is
 * not an entry this grammar accepts.
 */
export type ExecutorCommandPattern = {
  /** The arguments that must match literally, in order. */
  argumentPrefix: string[]
  /** True when further arguments are permitted after the prefix. */
  permitsFurtherArguments: boolean
  program: string
}

/**
 * The single parser both sides use: the one that decides whether an entry is
 * writable, and the one that decides whether a command matches it. A reading
 * that differed between them is the whole class of bug this avoids.
 */
export const parseExecutorCommandPattern = (
  entry: string,
): ExecutorCommandPattern | undefined => {
  if (entry.length === 0 || entry.length > EXECUTOR_COMMAND_PATTERN_MAXIMUM_LENGTH) return undefined
  if (entry.includes('\u0000')) return undefined
  // Written by hand, so runs of whitespace are a typo rather than an argument.
  const tokens = entry.trim().split(/\s+/u).filter((token) => token.length > 0)
  const [program, ...rest] = tokens
  if (program === undefined) return undefined
  if (!commandProgram.safeParse(program).success) return undefined
  const permitsFurtherArguments = rest.at(-1) === EXECUTOR_COMMAND_WILDCARD
  const argumentPrefix = permitsFurtherArguments ? rest.slice(0, -1) : rest
  // A `*` is only ever the final token. Anywhere else it is a rule whose
  // meaning depends on where a reader stops reading, and in the program
  // position — `*` alone, or `gi*` — it reads as "any program" while matching
  // a program name no PATH can resolve. Both are refused rather than given a
  // meaning a person would have to be told.
  if ([program, ...argumentPrefix].some((token) => token.includes(EXECUTOR_COMMAND_WILDCARD))) {
    return undefined
  }
  if (argumentPrefix.some((argument) => argument.length > 4_096)) return undefined
  return { argumentPrefix, permitsFurtherArguments, program }
}

/** The entry as it is stored and displayed, with hand-typed spacing normalised. */
export const formatExecutorCommandPattern = (pattern: ExecutorCommandPattern): string => [
  pattern.program,
  ...pattern.argumentPrefix,
  ...(pattern.permitsFurtherArguments ? [EXECUTOR_COMMAND_WILDCARD] : []),
].join(' ')

const commandPattern = z.string().superRefine((value, context) => {
  if (parseExecutorCommandPattern(value) !== undefined) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'A permitted command is a program the guest resolves through its fixed PATH, '
      + 'optionally followed by arguments and a trailing "*". Shells, paths and a leading "*" are refused.',
  })
})

const distinctEntries = (value: readonly string[]): boolean =>
  new Set(value).size === value.length
const commandAllowlistEntries = z.array(commandPattern).max(EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM)
export const ExecutorCommandAllowlistSchema = commandAllowlistEntries
  .refine(distinctEntries, 'Each permitted command is listed once.')
export type ExecutorCommandAllowlist = z.infer<typeof ExecutorCommandAllowlistSchema>

/**
 * The same list where an empty one would be meaningless — on the wire and in a
 * stored policy, a list is carried only when it names a command.
 */
export const ExecutorNonEmptyCommandAllowlistSchema = commandAllowlistEntries
  .min(1)
  .refine(distinctEntries, 'Each permitted command is listed once.')

/**
 * The one allowlist decision every reader shares — the daemon before it starts
 * a guest, and any surface that explains why a command was refused.
 *
 * The arguments are not optional. A caller that knew only the program could
 * only ask a weaker question than the policy answers, and every call site has
 * the argv it is about to run.
 *
 * An absent list is not an empty one, and neither permits anything: a daemon
 * paired before the allowlist existed advertises no list, and the safe reading
 * of "this policy has never named a command" is that none is permitted. The
 * remedy is one `configure --tools` call, which a person reviews.
 */
export const executorCommandAllowlistPermits = (
  allowlist: readonly string[] | undefined,
  program: string,
  args: readonly string[],
): boolean => (allowlist ?? []).some((entry) => {
  const pattern = parseExecutorCommandPattern(entry)
  if (pattern === undefined || pattern.program !== program) return false
  if (pattern.argumentPrefix.some((argument, index) => args[index] !== argument)) return false
  return pattern.permitsFurtherArguments
    ? args.length >= pattern.argumentPrefix.length
    : args.length === pattern.argumentPrefix.length
})

/** A shell-free argv command confined to the guest's COW workspace. */
export const ExecutorCommandRunArgumentsSchema = z
  .object({
    args: z.array(commandString(4_096)).max(64),
    cwd: commandString(1_024).refine(relativeWorkspacePath, 'cwd must stay within the workspace.').optional(),
    program: commandProgram,
  })
  .strict()
  .superRefine((value, context) => {
    if (commandArgumentBytes(value) > 24_576) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Command argv exceeds the executor control-frame budget.',
      })
    }
  })
export type ExecutorCommandRunArguments = z.infer<typeof ExecutorCommandRunArgumentsSchema>

/**
 * A coding task becomes a positional Codex prompt after a `--` option
 * delimiter. It is retained only in the encrypted executor command payload;
 * terminal output never returns to the control plane.
 */
export const ExecutorCodingLaunchArgumentsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_096),
  })
  .strict()
export type ExecutorCodingLaunchArguments = z.infer<typeof ExecutorCodingLaunchArgumentsSchema>

/** Coding lifecycle observation accepts no terminal selector or command. */
export const ExecutorCodingObserveArgumentsSchema = z.object({}).strict()
export type ExecutorCodingObserveArguments = z.infer<typeof ExecutorCodingObserveArgumentsSchema>

/**
 * Server-authored data for a human-confirmed COW promotion. This schema is
 * intentionally not included in the model-facing executor toolset: an agent
 * can prepare a draft and review it, but only a person can issue promotion.
 */
export const ExecutorWorkspacePromoteArgumentsSchema = z
  .object({
    approvalDigest: Sha256DigestSchema,
    manifestDigest: Sha256DigestSchema,
    promotionId: z.string().uuid(),
  })
  .strict()
export type ExecutorWorkspacePromoteArguments = z.infer<
  typeof ExecutorWorkspacePromoteArgumentsSchema
>

export const ExecutorPrivateAssignmentSchema = z.discriminatedUnion(
  'principalKind',
  [
    z
      .object({
        principalKind: z.literal('user'),
        userId: UserIdSchema,
        role: z.enum(['use', 'admin']),
      })
      .strict(),
    z
      .object({
        principalKind: z.literal('agent'),
        agentId: AgentIdSchema,
        role: z.literal('use'),
      })
      .strict(),
  ],
)
export type ExecutorPrivateAssignment = z.infer<
  typeof ExecutorPrivateAssignmentSchema
>

export const ExecutorAgentOperationGrantStateSchema = z.enum(['allowed', 'denied'])
export type ExecutorAgentOperationGrantState = z.infer<
  typeof ExecutorAgentOperationGrantStateSchema
>

export const ExecutorAgentOperationGrantSchema = z
  .object({
    executorId: ExecutorIdSchema,
    agentId: AgentIdSchema,
    operationKey: ImplementedExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
    authorizationRevision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict()
export type ExecutorAgentOperationGrant = z.infer<
  typeof ExecutorAgentOperationGrantSchema
>

/**
 * Protocol version 1 still carries the widened host facts. `platform`,
 * `supervisor`, and `sandboxBackend` are required, so a pre-widening descriptor
 * cannot validate and a widened one cannot be mistaken for an older grammar:
 * required fields already discriminate the two, and there has only ever been
 * one producer train (the companion ships inside the desktop app or the
 * executor package, never independently). A second version number would give
 * no reader a decision it cannot already make. A stored descriptor from before
 * the change fails closed, which is the right answer for a machine whose
 * sandbox backend is unknown; its companion proposes a new revision.
 */
export const ExecutorCapabilityDescriptorSchema = z
  .object({
    protocolVersion: z.literal(1),
    revision: z.number().int().positive(),
    profiles: z.array(ExecutorProfileSchema).min(1).max(2),
    platform: ExecutorPlatformSchema,
    supervisor: ExecutorSupervisorSchema,
    sandboxBackend: ExecutorSandboxBackendSchema,
    operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(EXECUTOR_DESCRIPTOR_OPERATION_MAXIMUM),
    // Present exactly when the policy names permitted programs, so a reviewer
    // approving `command.run` reads the list they are approving rather than a
    // digest. Absent from a daemon paired before the allowlist existed; that
    // daemon runs nothing through `command.run` until its policy names one.
    commandAllowlist: ExecutorNonEmptyCommandAllowlistSchema.optional(),
    // The named host folders this executor exposes, so adding one is a revision
    // a person reviews. Only the names travel: the host paths stay local,
    // because a reviewer of an organisation-scoped executor has no business
    // reading somebody's home directory layout. Absent means the single
    // unnamed folder every pre-naming pairing has.
    workspaceFolders: ExecutorWorkspaceFolderNamesSchema.optional(),
    // The named local MCP servers this executor fronts, so adding one is a
    // revision a person reviews. Only the names travel; how the daemon starts
    // each server stays on the host. Absent means this executor fronts none.
    mcpServers: ExecutorMcpServerNamesSchema.optional(),
    // What the built-in coding-sessions bridge may do — agents, permission
    // modes, pre-allowed tool count, root names and the digest of its host-local
    // configuration — so offering it, or widening it, is a revision a person
    // reviews. Absent means this executor does not offer the bridge.
    codingSessions: ExecutorCodingSessionsFactsSchema.optional(),
    localPolicyDigest: Sha256DigestSchema,
    limits: z
      .object({
        maxCommandRuntimeSeconds: z.number().int().positive(),
        maxResultBytes: z.number().int().positive(),
        maxSessions: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
export type ExecutorCapabilityDescriptor = z.infer<
  typeof ExecutorCapabilityDescriptorSchema
>

export const ExecutorSignedDescriptorSchema = z
  .object({
    descriptor: ExecutorCapabilityDescriptorSchema,
    signature: Base64UrlSchema,
  })
  .strict()
export type ExecutorSignedDescriptor = z.infer<
  typeof ExecutorSignedDescriptorSchema
>

export const ExecutorEnrollmentRequestSchema = z
  .object({
    enrollmentId: ExecutorEnrollmentIdSchema,
    challenge: Base64UrlSchema.min(32),
    machinePublicKey: Base64UrlSchema.min(32),
    descriptor: ExecutorSignedDescriptorSchema,
    proof: Base64UrlSchema.min(32),
  })
  .strict()
export type ExecutorEnrollmentRequest = z.infer<
  typeof ExecutorEnrollmentRequestSchema
>

export const ExecutorDaemonClaimRequestSchema = z.object({
  challenge: ExecutorDaemonChallengeTokenSchema,
  executorId: ExecutorIdSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonClaimRequest = z.infer<typeof ExecutorDaemonClaimRequestSchema>

export const ExecutorDaemonHeartbeatRequestSchema = z.object({
  monitor: ExecutorMonitorSnapshotSchema.optional(),
  monitorVersion: z.literal(1).optional(),
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  /**
   * What the daemon last observed about each MCP server its policy names —
   * whether it is installed, which version, and for Kelpie which browsers
   * answered on the network. It rides the heartbeat because it changes without
   * a policy change: installing Kelpie must not cost a reviewed revision.
   *
   * Absent means a daemon too old to report. An empty array means a daemon
   * that reports and names no server. The signed payload includes this field
   * exactly when it is present, so an older daemon's signature still verifies.
   */
  localMcp: ExecutorLocalMcpReportSchema.optional(),
  /**
   * Present, and `true`, exactly while the computer's owner has paused this
   * team on the computer itself. The daemon stays connected, refuses new work
   * (`EXECUTOR_OWNER_PAUSED`) and keeps reporting, so Nessie can show "Paused
   * on the computer" instead of "offline". Absent means not paused, which keeps
   * an unpaused daemon's signed payload byte-identical to an older daemon's.
   */
  ownerPaused: z.literal(true).optional(),
  /** What a Mac lacks for iMessage (`executor-imessage.ts`); sent only to a Nessie that answered with `imessage`. */
  imessage: ExecutorIMessageReportSchema.optional(),
  software: ExecutorSoftwareStatusSchema.optional(),
  observedAt: TimestampSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonHeartbeatRequest = z.infer<typeof ExecutorDaemonHeartbeatRequestSchema>

/** A connected daemon may advertise a newer signed local-policy descriptor. */
export const ExecutorDaemonDescriptorRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  descriptor: ExecutorSignedDescriptorSchema,
  executorId: ExecutorIdSchema,
}).strict()
export type ExecutorDaemonDescriptorRequest = z.infer<typeof ExecutorDaemonDescriptorRequestSchema>

/**
 * The command poll. Without `concurrency` it is the one-command-at-a-time
 * shape every daemon has sent (`activeCommand` asks only whether that command
 * is cancelled). With `concurrency: 1` the daemon also sends its free
 * `capacity` and every `activeCommands` it holds, and Nessie answers the
 * concurrent shape (`docs/sessions-and-concurrency.md`); `activeCommand` is
 * then absent. Every field present is inside the `poll`-domain signature.
 */
export const ExecutorDaemonCommandPollRequestSchema = z.object({
  activeCommand: ExecutorCommandCancellationTargetSchema.optional(),
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  observedAt: TimestampSchema,
  signature: ExecutorDaemonSignatureSchema,
}).merge(ExecutorConcurrentPollFieldsSchema.partial()).strict().superRefine((value, context) => {
  const concurrent = value.concurrency !== undefined
  const concurrentFields = [value.capacity, value.activeCommands, value.waiting, value.stoppedSessions]
  if (concurrent && (value.capacity === undefined || value.activeCommands === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A concurrent poll sends capacity and activeCommands.' })
  }
  if (!concurrent && concurrentFields.some((field) => field !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only a concurrent poll sends capacity, activeCommands, waiting or stoppedSessions.' })
  }
  if (concurrent && value.activeCommand !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A concurrent poll names its commands in activeCommands.' })
  }
})
export type ExecutorDaemonCommandPollRequest = z.infer<
  typeof ExecutorDaemonCommandPollRequestSchema
>

export const ExecutorDaemonChallengeResponseSchema = z.object({
  challenge: ExecutorDaemonChallengeTokenSchema,
  expiresAt: TimestampSchema,
}).strict()
export type ExecutorDaemonChallengeResponse = z.infer<typeof ExecutorDaemonChallengeResponseSchema>

export const ExecutorDaemonConnectionResponseSchema = z.object({
  sessionPairingSource: ExecutorSessionPairingSourceSchema.optional(),
  connectionEpoch: z.string().regex(/^\d+$/),
  status: ExecutorStatusSchema,
}).strict()
export type ExecutorDaemonConnectionResponse = z.infer<typeof ExecutorDaemonConnectionResponseSchema>

/**
 * The heartbeat answers with the connection, and with the coding sessions the
 * daemon must close: a lease that ended, access revoked, an executor paused, a
 * person's Close. The daemon reads `codingSessionClose` on its own, so a
 * field it does not know yet never fails its heartbeat.
 */
export const ExecutorDaemonHeartbeatResponseSchema = ExecutorDaemonConnectionResponseSchema.extend({
  monitorRequest: ExecutorMonitorRequestSchema.nullable().optional(),
  codingSessionClose: ExecutorCodingSessionCloseListSchema.optional(),
  existingSessionsAllowed: z.boolean().optional(),
  softwareUpdateRequest: ExecutorSoftwareUpdateRequestSchema.optional(),
  /** The owner's iMessage switch, for a macOS executor (`executor-imessage.ts`). */
  imessage: ExecutorIMessageSwitchSchema.optional(),
  /** Clients replies the owner pressed Send on, each handed to the Mac once (`executor-imessage.ts`). */
  imessageOutbox: z.array(ExecutorIMessageOutboxWireItemSchema).max(EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM).optional(),
}).strict()
export type ExecutorDaemonHeartbeatResponse = z.infer<typeof ExecutorDaemonHeartbeatResponseSchema>

export const ExecutorDaemonDescriptorResponseSchema = z.object({
  reviewStatus: z.enum(['pending_review', 'active', 'disabled']),
  revision: z.number().int().positive(),
}).strict()
export type ExecutorDaemonDescriptorResponse = z.infer<
  typeof ExecutorDaemonDescriptorResponseSchema
>

export const ExecutorAvailabilityReasonSchema = z.enum([
  'ready',
  'executor_not_discoverable',
  'executor_offline',
  'scope_mismatch',
  'operation_ungranted',
  'logical_tool_ungranted',
  'descriptor_unreviewed',
  'local_policy_denied',
  'credential_unavailable',
  /** The computer's owner paused this team on the computer (heartbeat `ownerPaused`). */
  'owner_paused',
])
export type ExecutorAvailabilityReason = z.infer<
  typeof ExecutorAvailabilityReasonSchema
>

export const ExecutorCandidateHandleSchema = z
  .string()
  .min(32)
  .max(512)
  .brand<'ExecutorCandidateHandle'>()
export type ExecutorCandidateHandle = z.infer<typeof ExecutorCandidateHandleSchema>

export const ExecutorAvailabilityRequestSchema = z
  .object({
    agentId: AgentIdSchema,
    operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(EXECUTOR_DESCRIPTOR_OPERATION_MAXIMUM),
    projectId: ProjectIdSchema.optional(),
    runId: RunIdSchema.optional(),
  })
  .strict()
export type ExecutorAvailabilityRequest = z.infer<
  typeof ExecutorAvailabilityRequestSchema
>

export const ExecutorAvailabilityCandidateSchema = z
  .object({
    handle: ExecutorCandidateHandleSchema,
    operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(EXECUTOR_DESCRIPTOR_OPERATION_MAXIMUM),
    readiness: z.literal('ready'),
    scopeKind: ExecutorScopeKindSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
export type ExecutorAvailabilityCandidate = z.infer<
  typeof ExecutorAvailabilityCandidateSchema
>

export const ExecutorAvailabilityExplanationSchema = z
  .object({
    readiness: z.literal('unavailable'),
    reason: ExecutorAvailabilityReasonSchema.exclude(['ready']),
  })
  .strict()
export type ExecutorAvailabilityExplanation = z.infer<
  typeof ExecutorAvailabilityExplanationSchema
>

export const ExecutorAvailabilityResponseSchema = z
  .object({
    candidates: z.array(ExecutorAvailabilityCandidateSchema).max(100),
    explanations: z.array(ExecutorAvailabilityExplanationSchema).max(16),
  })
  .strict()
export type ExecutorAvailabilityResponse = z.infer<
  typeof ExecutorAvailabilityResponseSchema
>

export const ExecutorRunBindRequestSchema = z.object({
  candidateHandle: ExecutorCandidateHandleSchema,
  operationKey: ImplementedExecutorOperationKeySchema,
}).strict()
export type ExecutorRunBindRequest = z.infer<typeof ExecutorRunBindRequestSchema>

export const ExecutorRunBindResponseSchema = z.object({
  bindingId: ExecutorBindingIdSchema,
  capabilityRevision: z.number().int().positive(),
  fence: z.string().regex(/^\d+$/),
  operationKey: ImplementedExecutorOperationKeySchema,
  runId: RunIdSchema,
}).strict()
export type ExecutorRunBindResponse = z.infer<typeof ExecutorRunBindResponseSchema>

/** A user-directed run whose executor selection is bound before queueing. */
export const ExecutorRunLaunchRequestSchema = z.object({
  agentId: AgentIdSchema,
  candidateHandle: ExecutorCandidateHandleSchema,
  content: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  // Every operation in this bundle is independently re-authorized and bound
  // under the same opaque candidate. This lets draft work and its read-only
  // review stay on the same COW workspace without a model selecting a machine.
  operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(4).superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Operation keys must be unique.' })
    }
    const browserBundle: ImplementedExecutorOperationKey[] = [
      'browser.open',
      'browser.observe',
      'browser.act',
      'sandbox.stop',
    ]
    const browserRequested = value.includes('browser.open')
      || value.includes('browser.observe')
      || value.includes('browser.act')
    if (browserRequested && (
      value.length !== browserBundle.length
      || browserBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Browser runs are exactly browser.open, browser.observe, browser.act, and sandbox.stop.',
      })
    }
    const connectedBrowserBundle: ImplementedExecutorOperationKey[] = [
      'browser.connected.open',
      'browser.connected.observe',
      'browser.connected.act',
      'sandbox.stop',
    ]
    const connectedBrowserRequested = value.includes('browser.connected.open')
      || value.includes('browser.connected.observe')
      || value.includes('browser.connected.act')
    if (connectedBrowserRequested && (
      value.length !== connectedBrowserBundle.length
      || connectedBrowserBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Connected browser runs are exactly browser.connected.open, browser.connected.observe, browser.connected.act, and sandbox.stop.',
      })
    }
    const codingBundle: ImplementedExecutorOperationKey[] = [
      'coding.launch',
      'coding.observe',
      'workspace.review',
      'sandbox.stop',
    ]
    const codingRequested = value.includes('coding.launch') || value.includes('coding.observe')
    const commandBundle: ImplementedExecutorOperationKey[] = [
      'command.run',
      'workspace.review',
      'sandbox.stop',
    ]
    const commandRequested = value.includes('command.run')
    // The MCP proxy needs no sandbox and promotes nothing, so its bundle is
    // just the two operations. It stays exclusive of the others for the same
    // reason they are exclusive of each other: one run, one kind of reach.
    const mcpBundle: ImplementedExecutorOperationKey[] = ['mcp.tools', 'mcp.call']
    const mcpRequested = value.includes('mcp.tools') || value.includes('mcp.call')
    if (
      (browserRequested && (codingRequested || commandRequested || connectedBrowserRequested || mcpRequested))
      || (connectedBrowserRequested && (codingRequested || commandRequested || mcpRequested))
      || (codingRequested && (commandRequested || mcpRequested))
      || (commandRequested && mcpRequested)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Isolated browser, connected browser, coding, command, and local MCP operations cannot share one executor run.',
      })
    }
    if (mcpRequested && (
      value.length !== mcpBundle.length
      || mcpBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Local MCP runs are exactly mcp.tools and mcp.call.',
      })
    }
    if (codingRequested && (
      value.length !== codingBundle.length
      || codingBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Coding runs are exactly coding.launch, coding.observe, workspace.review, and sandbox.stop.',
      })
    }
    if (commandRequested && (
      value.length !== commandBundle.length
      || commandBundle.some((operationKey) => !value.includes(operationKey))
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Command runs are exactly command.run, workspace.review, and sandbox.stop.',
      })
    }
  }),
}).strict()
export type ExecutorRunLaunchRequest = z.infer<typeof ExecutorRunLaunchRequestSchema>

export const ExecutorRunLaunchResponseSchema = z.object({
  bindings: z.array(ExecutorRunBindResponseSchema).min(1).max(4),
  messageId: z.string().uuid(),
  runId: RunIdSchema,
  taskId: TaskIdSchema,
}).strict()
export type ExecutorRunLaunchResponse = z.infer<typeof ExecutorRunLaunchResponseSchema>

export const ExecutorCommandReceiptStateSchema = z.enum([
  'accepted',
  'started',
  'result_acknowledged',
  'unknown_outcome',
])
export type ExecutorCommandReceiptState = z.infer<
  typeof ExecutorCommandReceiptStateSchema
>

export const ExecutorCommandEnvelopeSchema = z
  .object({
    commandId: ExecutorCommandIdSchema,
    bindingId: ExecutorBindingIdSchema,
    bindingFence: z.string().regex(/^\d+$/),
    capabilityRevision: z.number().int().positive(),
    operationKey: ImplementedExecutorOperationKeySchema,
    expiresAt: TimestampSchema,
    idempotencyKey: z.string().min(1).max(255),
    argumentDigest: Sha256DigestSchema,
    payload: NonEmptyRecordSchema,
    /**
     * The session the command belongs to, and the display name of the agent
     * whose run it is (shown to the owner in a program request). Sent only in
     * answer to a concurrent poll: an older daemon parses the envelope
     * strictly and would refuse either field.
     */
    sessionId: ExecutorSessionIdSchema.optional(),
    agentName: z.string().trim().min(1).max(EXECUTOR_AGENT_NAME_MAX_CHARS).optional(),
  })
  .strict()
export type ExecutorCommandEnvelope = z.infer<typeof ExecutorCommandEnvelopeSchema>

export const ExecutorCommandReceiptSchema = z
  .object({
    commandId: ExecutorCommandIdSchema,
    // `unknown_outcome` is server-owned recovery state, never a daemon claim.
    state: z.enum(['accepted', 'started', 'result_acknowledged']),
    resultDigest: Sha256DigestSchema.optional(),
    occurredAt: TimestampSchema,
  })
  .strict()
export type ExecutorCommandReceipt = z.infer<typeof ExecutorCommandReceiptSchema>

/** The answer to a poll without `concurrency`: one command, or whether the active one is cancelled. */
export const ExecutorDaemonLegacyCommandPollResponseSchema = z.object({
  cancellation: ExecutorCommandCancellationSchema.nullable().optional(),
  command: ExecutorCommandEnvelopeSchema.nullable(),
}).strict()
export type ExecutorDaemonLegacyCommandPollResponse = z.infer<
  typeof ExecutorDaemonLegacyCommandPollResponseSchema
>

/**
 * The answer to a concurrent poll: up to the free capacity of new commands,
 * oldest first, each with its `sessionId`; cancellations for commands the
 * poll named; and sessions Nessie ended.
 */
export const ExecutorDaemonConcurrentCommandPollResponseSchema = z.object({
  commands: z.array(ExecutorCommandEnvelopeSchema).max(EXECUTOR_CONCURRENT_COMMANDS_MAXIMUM),
}).merge(ExecutorConcurrentPollAnswerFieldsSchema).strict()
export type ExecutorDaemonConcurrentCommandPollResponse = z.infer<
  typeof ExecutorDaemonConcurrentCommandPollResponseSchema
>

export const ExecutorDaemonCommandPollResponseSchema = z.union([
  ExecutorDaemonConcurrentCommandPollResponseSchema,
  ExecutorDaemonLegacyCommandPollResponseSchema,
])
export type ExecutorDaemonCommandPollResponse = z.infer<
  typeof ExecutorDaemonCommandPollResponseSchema
>

export const ExecutorDaemonCommandReceiptRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  receipt: ExecutorCommandReceiptSchema,
  result: NonEmptyRecordSchema.optional(),
  signature: ExecutorDaemonSignatureSchema,
}).strict().superRefine((value, context) => {
  if (value.receipt.state === 'result_acknowledged' && !value.result) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A result acknowledgement requires a structured result.',
      path: ['result'],
    })
  }
  if (value.receipt.state !== 'result_acknowledged' && value.result !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only a result acknowledgement may carry a result.',
      path: ['result'],
    })
  }
})
export type ExecutorDaemonCommandReceiptRequest = z.infer<
  typeof ExecutorDaemonCommandReceiptRequestSchema
>

/** `remove` is `revoke` plus hiding the executor from people-facing reads. */
export const ExecutorLifecycleActionSchema = z.enum(['pause', 'resume', 'drain', 'revoke', 'remove'])
export type ExecutorLifecycleAction = z.infer<typeof ExecutorLifecycleActionSchema>

export const ExecutorPrivateAssignmentPrincipalSchema = z.discriminatedUnion(
  'principalKind',
  [
    z.object({ principalKind: z.literal('user'), userId: UserIdSchema }).strict(),
    z.object({ principalKind: z.literal('agent'), agentId: AgentIdSchema }).strict(),
  ],
)
export type ExecutorPrivateAssignmentPrincipal = z.infer<
  typeof ExecutorPrivateAssignmentPrincipalSchema
>

export const ExecutorAccessChangeRequestSchema = z.union([
  z.object({
    kind: z.literal('private_assignment'),
    action: z.literal('set'),
    assignment: ExecutorPrivateAssignmentSchema,
  }).strict(),
  z.object({
    kind: z.literal('private_assignment'),
    action: z.literal('remove'),
    principal: ExecutorPrivateAssignmentPrincipalSchema,
  }).strict(),
  z.object({
    kind: z.literal('agent_operation_grant'),
    agentId: AgentIdSchema,
    operationKey: ImplementedExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
  }).strict(),
  // The whole suite in one prepared change. It names no operation key on
  // purpose: the set is derived at apply time from the revision the person
  // reviewed, so a change prepared before a revision landed cannot grant an
  // operation that revision does not offer.
  z.object({
    kind: z.literal('agent_executor_grant'),
    agentId: AgentIdSchema,
    state: ExecutorAgentOperationGrantStateSchema,
  }).strict(),
  z.object({
    kind: z.literal('agent_executor_access'),
    agentId: AgentIdSchema,
    state: ExecutorAgentOperationGrantStateSchema,
  }).strict(),
  z.object({
    kind: z.literal('lifecycle'),
    action: ExecutorLifecycleActionSchema,
  }).strict(),
  z.object({
    kind: z.literal('descriptor_review'),
    revision: z.number().int().positive(),
    status: z.enum(['active', 'disabled']),
  }).strict(),
])
export type ExecutorAccessChangeRequest = z.infer<
  typeof ExecutorAccessChangeRequestSchema
>

export const ExecutorAccessChangeConfirmationSchema = z
  .object({
    accessChangeId: ExecutorAccessChangeIdSchema,
    confirmationToken: Base64UrlSchema.min(32),
    verificationChallengeId: z.string().uuid().optional(),
  })
  .strict()
export type ExecutorAccessChangeConfirmation = z.infer<
  typeof ExecutorAccessChangeConfirmationSchema
>

export const ExecutorRecordResponseSchema = z.object({
  software: ExecutorSoftwareStatusSchema.optional(),
  softwareObservedAt: TimestampSchema.optional(),
  softwareUpdateRequested: z.boolean().optional(),
  sharedWithTeam: z.boolean().optional(),
  // On the person's own list only: whether they paired this machine, which
  // splits Your computers into Mine and Shared with me.
  pairedByViewer: z.boolean().optional(),
  // On the owner's single read only: the computer's captured owner proof is
  // missing or spent, and the owner's confirmation restores it.
  ownerConfirmationNeeded: z.literal(true).optional(),
  // On list reads only: how the reader reaches it (theirs, a person's share,
  // the whole team, or a project), so the list can say so without a second read.
  viewerAccess: ExecutorViewerAccessSchema.optional(),
  id: ExecutorIdSchema,
  scope: ExecutorScopeSchema,
  label: z.string().min(1),
  profiles: z.array(ExecutorProfileSchema),
  // Absent until the paired daemon submits its first descriptor. Read-only:
  // the host states these facts under its own signature and no API caller can
  // write them.
  platformFacts: ExecutorPlatformFactsSchema.optional(),
  machineKeyFingerprint: z.string().optional(),
  status: ExecutorStatusSchema,
  authorizationRevision: z.number().int().positive(),
  lastSeenAt: TimestampSchema.optional(),
  statusDetail: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutorRecordResponse = z.infer<typeof ExecutorRecordResponseSchema>

export const ExecutorPairingInvitationResponseSchema = z.object({
  enrollmentId: ExecutorEnrollmentIdSchema,
  challenge: z.string().min(32),
  expiresAt: TimestampSchema,
  // The origin the paired daemon must call. It is a deployment fact, not a
  // browser one: the executor runs outside the browser and so cannot reach the
  // admin's `/api` dev proxy. Optional because only the operator-declared
  // public origin may fill it, and a local deployment that has declared none
  // leaves the client to fall back to its own build-time configuration.
  apiBaseUrl: z.string().url().optional(),
})
export type ExecutorPairingInvitationResponse = z.infer<
  typeof ExecutorPairingInvitationResponseSchema
>

export const ExecutorCreateResponseSchema = z.object({
  executor: ExecutorRecordResponseSchema,
  invitation: ExecutorPairingInvitationResponseSchema,
})
export type ExecutorCreateResponse = z.infer<typeof ExecutorCreateResponseSchema>

export const PendingExecutorEnrollmentResponseSchema = z.object({
  executorId: ExecutorIdSchema,
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  descriptorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: TimestampSchema,
})
export type PendingExecutorEnrollmentResponse = z.infer<
  typeof PendingExecutorEnrollmentResponseSchema
>

export const ExecutorPrivateAssignmentResponseSchema = z.discriminatedUnion(
  'principalKind',
  [
    z.object({
      principalKind: z.literal('user'),
      role: z.enum(['use', 'admin']),
      userId: UserIdSchema,
    }).strict(),
    z.object({
      agentId: AgentIdSchema,
      principalKind: z.literal('agent'),
      role: z.literal('use'),
    }).strict(),
  ],
)
export type ExecutorPrivateAssignmentResponse = z.infer<
  typeof ExecutorPrivateAssignmentResponseSchema
>

/** A reviewed, signed local policy proposal. The raw signature remains server-only. */
export const ExecutorDescriptorReviewResponseSchema = z.object({
  // Projected verbatim from the signed descriptor, so a reviewer approving
  // `command.run` reads the programs they are approving rather than only the
  // digest that covers them. Absent exactly when the descriptor named none —
  // which permits none — and never an empty array, because that would be a
  // third reading of a two-state fact.
  commandAllowlist: ExecutorNonEmptyCommandAllowlistSchema.optional(),
  // The built-in coding bridge's power facts, verbatim: offering it or widening
  // it is a revision, and a coding agent acts with the machine owner's full
  // authority. Absent exactly when the descriptor does not offer the bridge.
  codingSessions: ExecutorCodingSessionsFactsSchema.optional(),
  localPolicyDigest: Sha256DigestSchema,
  // Projected for the same reason as the programs and the folders: naming a
  // local MCP server changes the digest, so it is a revision somebody
  // approves, and a reviewer should read which servers they are approving.
  // Names only — how each one starts stays on the host.
  mcpServers: ExecutorMcpServerNamesSchema.optional(),
  operationKeys: z.array(ImplementedExecutorOperationKeySchema).min(1).max(100),
  profiles: z.array(ExecutorProfileSchema).min(1).max(10),
  reviewStatus: z.enum(['pending_review', 'active', 'disabled']),
  revision: z.number().int().positive(),
  // Projected for the same reason as the programs: adding a folder changes the
  // digest, so it is a revision somebody approves, and a reviewer should read
  // which folders they are approving. Names only — the host paths stay on the
  // machine. Absent on a descriptor signed before folders had names, which
  // describes exactly one folder.
  workspaceFolders: ExecutorWorkspaceFolderNamesSchema.optional(),
}).strict()
export type ExecutorDescriptorReviewResponse = z.infer<
  typeof ExecutorDescriptorReviewResponseSchema
>

export const ExecutorSessionStatusSchema = z.enum([
  'pending',
  'active',
  'attention',
  'detached',
  'stopped',
  'failed',
])
export type ExecutorSessionStatus = z.infer<typeof ExecutorSessionStatusSchema>

export const ExecutorSessionSummaryResponseSchema = z.object({
  createdAt: TimestampSchema,
  id: ExecutorSessionIdSchema,
  originChannelId: ChannelIdSchema.optional(),
  profile: ExecutorProfileSchema,
  runId: RunIdSchema.optional(),
  status: ExecutorSessionStatusSchema,
  updatedAt: TimestampSchema,
}).strict()
export type ExecutorSessionSummaryResponse = z.infer<typeof ExecutorSessionSummaryResponseSchema>

export const ExecutorAccessViewResponseSchema = z.object({
  canManage: z.boolean(),
  executorId: ExecutorIdSchema,
  effectiveAccess: z.object({
    organizationRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullable(),
    privateAssignment: z.enum(['none', 'use', 'admin']),
    projectRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullable(),
  }).strict(),
  descriptorRevisions: z.array(ExecutorDescriptorReviewResponseSchema).max(20).optional(),
  /**
   * The daemon's last observation of its named MCP servers, and for Kelpie the
   * browsers it found. Absent means this executor has never reported — a
   * daemon too old, or one that has never connected. An empty array means it
   * reports and names no server. The two must never render alike.
   */
  localMcp: ExecutorLocalMcpReportSchema.optional(),
  /** When that observation was taken, so a reader can tell fresh from stale. */
  localMcpObservedAt: TimestampSchema.optional(),
  operationGrants: z.array(z.object({
    agentId: AgentIdSchema,
    operationKey: ImplementedExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
    updatedAt: TimestampSchema,
  }).strict()).optional(),
  privateAssignments: z.array(ExecutorPrivateAssignmentResponseSchema).optional(),
  sessions: z.array(ExecutorSessionSummaryResponseSchema).max(20).optional(),
})
export type ExecutorAccessViewResponse = z.infer<
  typeof ExecutorAccessViewResponseSchema
>

/** A content-free, human-reviewable COW change summary. */
export const ExecutorWorkspaceReviewChangeSchema = z.object({
  byteCount: z.number().int().nonnegative(),
  kind: z.enum(['created', 'modified', 'deleted']),
  path: z.string().min(1).max(1_024),
}).strict()
export type ExecutorWorkspaceReviewChange = z.infer<typeof ExecutorWorkspaceReviewChangeSchema>

export const ExecutorWorkspaceReviewRecordResponseSchema = z.object({
  acknowledgedAt: TimestampSchema,
  changes: z.array(ExecutorWorkspaceReviewChangeSchema).max(100),
  commandId: ExecutorCommandIdSchema,
  manifestDigest: Sha256DigestSchema,
  runId: RunIdSchema,
}).strict()
export type ExecutorWorkspaceReviewRecordResponse = z.infer<
  typeof ExecutorWorkspaceReviewRecordResponseSchema
>

/** A review may be promoted only by the user whose run produced it. */
export const OriginatingExecutorWorkspaceReviewRecordResponseSchema =
  ExecutorWorkspaceReviewRecordResponseSchema.extend({
    executorId: ExecutorIdSchema,
  }).strict()
export type OriginatingExecutorWorkspaceReviewRecordResponse = z.infer<
  typeof OriginatingExecutorWorkspaceReviewRecordResponseSchema
>

export const ExecutorWorkspacePromotionPrepareRequestSchema = z.object({
  reviewCommandId: ExecutorCommandIdSchema,
}).strict()
export type ExecutorWorkspacePromotionPrepareRequest = z.infer<
  typeof ExecutorWorkspacePromotionPrepareRequestSchema
>

export const PreparedExecutorWorkspacePromotionResponseSchema = z.object({
  changeCount: z.number().int().nonnegative().max(100),
  confirmationToken: Base64UrlSchema.min(32),
  executorId: ExecutorIdSchema,
  expiresAt: TimestampSchema,
  manifestDigest: Sha256DigestSchema,
  promotionId: ExecutorWorkspacePromotionIdSchema,
  runId: RunIdSchema,
}).strict()
export type PreparedExecutorWorkspacePromotionResponse = z.infer<
  typeof PreparedExecutorWorkspacePromotionResponseSchema
>

export const ExecutorWorkspacePromotionRecordResponseSchema = z.object({
  changeCount: z.number().int().nonnegative().max(100),
  executorId: ExecutorIdSchema,
  expiresAt: TimestampSchema,
  manifestDigest: Sha256DigestSchema,
  promotionId: ExecutorWorkspacePromotionIdSchema,
  requiresFreshVerification: z.literal(true),
  runId: RunIdSchema,
  status: z.enum(['pending', 'confirmed', 'consumed', 'rejected', 'expired']),
}).strict()
export type ExecutorWorkspacePromotionRecordResponse = z.infer<
  typeof ExecutorWorkspacePromotionRecordResponseSchema
>

export const ExecutorSsoVerificationSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
}).strict()
export type ExecutorSsoVerification = z.infer<typeof ExecutorSsoVerificationSchema>

export const ExecutorVerificationChallengeSchema = z.object({
  challengeId: z.string().uuid(), expiresAt: TimestampSchema, twoFactorRequired: z.boolean(),
})

export const ExecutorAccessChangeResponseSchema = z.object({
  accessChangeId: ExecutorAccessChangeIdSchema,
  executorId: ExecutorIdSchema,
  change: z.record(z.string(), z.unknown()),
  expiresAt: TimestampSchema,
  requiresFreshVerification: z.boolean(),
  verificationMethod: z.enum(['password', 'sso_code', 'unavailable']).optional(),
  status: z.enum(['pending', 'confirmed', 'rejected', 'expired', 'consumed']),
})
export type ExecutorAccessChangeResponse = z.infer<
  typeof ExecutorAccessChangeResponseSchema
>

export const PreparedExecutorAccessChangeResponseSchema = z.object({
  accessChangeId: ExecutorAccessChangeIdSchema,
  confirmationToken: Base64UrlSchema.min(32),
  executorId: ExecutorIdSchema,
  expiresAt: TimestampSchema,
  requiresFreshVerification: z.boolean(),
})
export type PreparedExecutorAccessChangeResponse = z.infer<
  typeof PreparedExecutorAccessChangeResponseSchema
>
import { ExecutorSessionPairingSourceSchema } from './executor-session-authority.js'
