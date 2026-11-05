import { WorkspacePathError } from './workspace-paths.js'

/**
 * Everything the guest is allowed to say back, and nothing else. These
 * validators are deliberately separate from the frame transport in
 * `guest-vm-control.ts`: framing decides whether bytes are a response at all,
 * while every function here decides whether a *decoded* payload is one of the
 * exact shapes the guest protocol permits — no extra keys, every bound
 * checked, and a refusal in words rather than a cast.
 */
export const guestPayloadUnavailable = (message: string): WorkspacePathError =>
  new WorkspacePathError(message)

export const isGuestRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

export type GuestRuntimeInspection = {
  browser: boolean
  claude: boolean
  codex: boolean
  tmux: boolean
}

export type GuestBrowserObservation = {
  snapshotVersion?: 1
  accessibilityTree: Array<{
    name: string
    nodeId: number
    role: string
    value?: string
    snapshotExcluded?: boolean
    snapshotName?: string
  }>
  screenshot?: {
    dataBase64: string
    mime: 'image/webp'
  }
  targets: Array<{
    title: string
    type: 'page'
    url: string
  }>
}

export type GuestBrowserAction =
  | { action: 'navigate'; url: string }
  | { action: 'click'; nodeId: number }
  | { action: 'type'; nodeId: number; text: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; deltaY: number; nodeId?: number }

export type GuestBrowserActionResult = {
  settledUrl?: string
  status: 'acted'
}

export type GuestCommandRequest = {
  args: string[]
  cwd?: string
  maxResultBytes: number
  program: string
  runtimeSeconds: number
}

export type GuestCommandResult = {
  exitCode: number
  output: string
  success: boolean
}

export type GuestCodingAgent = 'claude' | 'codex'

export type GuestCodingObservation = {
  agent: GuestCodingAgent
  exitStatus?: number
  lifecycle: 'exited' | 'running'
}

export const parseInspection = (payload: Buffer): GuestRuntimeInspection => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the runtime inspection request.')
  }
  if (!isGuestRecord(value) || Object.keys(value).some((key) => !['inspection', 'version'].includes(key)) || value.version !== 1 || !isGuestRecord(value.inspection)) {
    throw guestPayloadUnavailable('The executor guest rejected the runtime inspection request.')
  }
  const inspection = value.inspection
  if (
    Object.keys(inspection).some((key) => !['browser', 'claude', 'codex', 'tmux'].includes(key))
    || typeof inspection.browser !== 'boolean'
    || typeof inspection.claude !== 'boolean'
    || typeof inspection.codex !== 'boolean'
    || typeof inspection.tmux !== 'boolean'
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the runtime inspection request.')
  }
  return {
    browser: inspection.browser,
    claude: inspection.claude,
    codex: inspection.codex,
    tmux: inspection.tmux,
  }
}

export const parseBrowserOpen = (payload: Buffer): void => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the browser launch request.')
  }
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['status', 'version'].includes(key))
    || value.status !== 'started'
    || value.version !== 1
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the browser launch request.')
  }
}

export const parseBrowserObservation = (payload: Buffer): GuestBrowserObservation => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the browser observation request.')
  }
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['observation', 'version'].includes(key))
    || value.version !== 1
    || !isGuestRecord(value.observation)
    || Object.keys(value.observation).some((key) => !['accessibilityTree', 'screenshot', 'targets', 'snapshotVersion'].includes(key))
    || (value.observation.snapshotVersion !== undefined && value.observation.snapshotVersion !== 1)
    || !Array.isArray(value.observation.targets)
    || value.observation.targets.length > 32
    || !Array.isArray(value.observation.accessibilityTree)
    || value.observation.accessibilityTree.length > 200
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the browser observation request.')
  }
  const targets = value.observation.targets.map((target): GuestBrowserObservation['targets'][number] => {
    if (
      !isGuestRecord(target)
      || Object.keys(target).some((key) => !['title', 'type', 'url'].includes(key))
      || typeof target.title !== 'string'
      || target.title.length > 512
      || target.type !== 'page'
      || typeof target.url !== 'string'
      || target.url.length > 4_096
    ) {
      throw guestPayloadUnavailable('The executor guest rejected the browser observation request.')
    }
    return { title: target.title, type: target.type, url: target.url }
  })
  const accessibilityTree = value.observation.accessibilityTree.map((node): GuestBrowserObservation['accessibilityTree'][number] => {
    if (
      !isGuestRecord(node)
      || Object.keys(node).some((key) => !['name', 'nodeId', 'role', 'value', 'snapshotExcluded', 'snapshotName'].includes(key))
      || (node.snapshotExcluded !== undefined && typeof node.snapshotExcluded !== 'boolean')
      || (node.snapshotName !== undefined && (typeof node.snapshotName !== 'string' || Buffer.byteLength(node.snapshotName, 'utf8') > 256))
      || typeof node.nodeId !== 'number'
      || !Number.isInteger(node.nodeId)
      || node.nodeId < 0
      || node.nodeId > 2_147_483_647
      || typeof node.role !== 'string'
      || Buffer.byteLength(node.role, 'utf8') > 256
      || typeof node.name !== 'string'
      || Buffer.byteLength(node.name, 'utf8') > 256
      || (node.value !== undefined && (typeof node.value !== 'string' || Buffer.byteLength(node.value, 'utf8') > 256))
    ) {
      throw guestPayloadUnavailable('The executor guest rejected the browser observation request.')
    }
    return {
      ...(node.snapshotExcluded === undefined ? {} : { snapshotExcluded: node.snapshotExcluded }),
      ...(node.snapshotName === undefined ? {} : { snapshotName: node.snapshotName }),
      name: node.name,
      nodeId: node.nodeId,
      role: node.role,
      ...(node.value === undefined ? {} : { value: node.value }),
    }
  })
  const screenshot = value.observation.screenshot
  let parsedScreenshot: GuestBrowserObservation['screenshot']
  if (screenshot !== undefined) {
    const dataBase64 = isGuestRecord(screenshot) ? screenshot.dataBase64 : undefined
    if (
      !isGuestRecord(screenshot)
      || Object.keys(screenshot).some((key) => !['dataBase64', 'mime'].includes(key))
      || screenshot.mime !== 'image/webp'
      || typeof dataBase64 !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)
      || Buffer.from(dataBase64, 'base64').byteLength > 8_192
    ) {
      throw guestPayloadUnavailable('The executor guest rejected the browser observation request.')
    }
    parsedScreenshot = { dataBase64, mime: 'image/webp' }
  }
  if (payload.byteLength > 24_576) {
    throw guestPayloadUnavailable('The executor guest rejected the browser observation request.')
  }
  return {
    ...(value.observation.snapshotVersion === 1 ? { snapshotVersion: 1 as const } : {}),
    accessibilityTree,
    ...(parsedScreenshot === undefined ? {} : { screenshot: parsedScreenshot }),
    targets,
  }
}

export const parseBrowserAction = (payload: Buffer): GuestBrowserActionResult => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the browser action request.')
  }
  if (!isGuestRecord(value) || Object.keys(value).some((key) => !['action', 'version'].includes(key)) || value.version !== 1 || !isGuestRecord(value.action)) {
    throw guestPayloadUnavailable('The executor guest rejected the browser action request.')
  }
  const action = value.action
  if (
    Object.keys(action).some((key) => !['settledUrl', 'status'].includes(key))
    || action.status !== 'acted'
    || (action.settledUrl !== undefined && (typeof action.settledUrl !== 'string' || action.settledUrl.length > 4_096))
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the browser action request.')
  }
  return { status: 'acted', ...(action.settledUrl === undefined ? {} : { settledUrl: action.settledUrl }) }
}

export const parseCommandResult = (payload: Buffer): GuestCommandResult => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the command request.')
  }
  if (!isGuestRecord(value) || Object.keys(value).some((key) => !['result', 'version'].includes(key)) || value.version !== 1 || !isGuestRecord(value.result)) {
    throw guestPayloadUnavailable('The executor guest rejected the command request.')
  }
  const result = value.result
  if (
    Object.keys(result).some((key) => !['exitCode', 'output', 'success'].includes(key))
    || typeof result.exitCode !== 'number'
    || !Number.isInteger(result.exitCode)
    || result.exitCode < 0
    || result.exitCode > 255
    || typeof result.output !== 'string'
    || Buffer.byteLength(result.output, 'utf8') > 8_192
    || typeof result.success !== 'boolean'
    || result.success !== (result.exitCode === 0)
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the command request.')
  }
  return { exitCode: result.exitCode, output: result.output, success: result.success }
}

const isCodingAgent = (value: unknown): value is GuestCodingAgent => value === 'claude' || value === 'codex'

export const parseCodingLaunch = (payload: Buffer, agent: GuestCodingAgent): void => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session launch request.')
  }
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['agent', 'status', 'version'].includes(key))
    || value.agent !== agent
    || value.status !== 'started'
    || value.version !== 1
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session launch request.')
  }
}

export const parseCodingObservation = (payload: Buffer): GuestCodingObservation => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session observation request.')
  }
  if (!isGuestRecord(value) || Object.keys(value).some((key) => !['observation', 'version'].includes(key)) || value.version !== 1 || !isGuestRecord(value.observation)) {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session observation request.')
  }
  const observation = value.observation
  const agent = observation.agent
  const lifecycle = observation.lifecycle
  const exitStatus = observation.exitStatus
  if (
    Object.keys(observation).some((key) => !['agent', 'exitStatus', 'lifecycle'].includes(key))
    || !isCodingAgent(agent)
    || (lifecycle !== 'exited' && lifecycle !== 'running')
    || (exitStatus !== undefined && (typeof exitStatus !== 'number' || !Number.isInteger(exitStatus) || exitStatus < 0 || exitStatus > 255))
    || (lifecycle === 'running' && exitStatus !== undefined)
    || (lifecycle === 'exited' && exitStatus === undefined)
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session observation request.')
  }
  return {
    agent,
    ...(exitStatus === undefined ? {} : { exitStatus }),
    lifecycle,
  }
}

export const parseCodingClose = (payload: Buffer): void => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session close request.')
  }
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['status', 'version'].includes(key))
    || value.status !== 'closed'
    || value.version !== 1
  ) {
    throw guestPayloadUnavailable('The executor guest rejected the coding-session close request.')
  }
}


export type GuestDraftEntryKind = 'dir' | 'file' | 'whiteout'

export type GuestDraftEntry = {
  kind: GuestDraftEntryKind
  /** Permission bits only; the host applies its own owner and umask. */
  mode: number
  /**
   * A directory overlayfs marked opaque: the workload emptied it, so whatever
   * the host still holds there must go before the entries that follow are
   * applied. Without it a `rm -rf dir` would leave the removed children in the
   * host's overlay and the review would not report them deleted.
   */
  opaque?: boolean
  /** Slash-separated and relative to the draft root; never absolute. */
  path: string
  size: number
}

export type GuestDraftScan = {
  entries: GuestDraftEntry[]
  next?: number
}

export type GuestDraftChunk = {
  bytes: Buffer
  eof: boolean
}

/** One control frame carries at most this many entries; the host pages. */
export const GUEST_DRAFT_SCAN_MAX_ENTRIES = 64
/** Raw bytes per read; base64 of this stays well inside the payload ceiling. */
export const GUEST_DRAFT_READ_MAX_BYTES = 16_384
export const GUEST_DRAFT_PATH_MAX_BYTES = 1_024

const isDraftKind = (value: unknown): value is GuestDraftEntryKind =>
  value === 'dir' || value === 'file' || value === 'whiteout'

const draftRefusal = 'The executor guest rejected the workspace draft request.'

const parseDraftEntry = (value: unknown): GuestDraftEntry => {
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['kind', 'mode', 'opaque', 'path', 'size'].includes(key))
    || !isDraftKind(value.kind)
    || typeof value.mode !== 'number'
    || !Number.isInteger(value.mode)
    || value.mode < 0
    || value.mode > 0o777
    || typeof value.path !== 'string'
    || value.path.length === 0
    || Buffer.byteLength(value.path, 'utf8') > GUEST_DRAFT_PATH_MAX_BYTES
    || typeof value.size !== 'number'
    || !Number.isInteger(value.size)
    || value.size < 0
    || (value.kind !== 'file' && value.size !== 0)
    || (value.opaque !== undefined && (typeof value.opaque !== 'boolean' || value.kind !== 'dir'))
  ) {
    throw guestPayloadUnavailable(draftRefusal)
  }
  return {
    kind: value.kind,
    mode: value.mode,
    ...(value.opaque === true ? { opaque: true } : {}),
    path: value.path,
    size: value.size,
  }
}

export const parseDraftScan = (payload: Buffer): GuestDraftScan => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable(draftRefusal)
  }
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['entries', 'next', 'version'].includes(key))
    || value.version !== 1
    || !Array.isArray(value.entries)
    || value.entries.length > GUEST_DRAFT_SCAN_MAX_ENTRIES
    || (value.next !== undefined
      && (typeof value.next !== 'number' || !Number.isInteger(value.next) || value.next < 0))
  ) {
    throw guestPayloadUnavailable(draftRefusal)
  }
  return {
    entries: value.entries.map(parseDraftEntry),
    ...(value.next === undefined ? {} : { next: value.next }),
  }
}

export const parseDraftChunk = (payload: Buffer): GuestDraftChunk => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw guestPayloadUnavailable(draftRefusal)
  }
  const encoded = isGuestRecord(value) ? value.bytes : undefined
  if (
    !isGuestRecord(value)
    || Object.keys(value).some((key) => !['bytes', 'eof', 'version'].includes(key))
    || value.version !== 1
    || typeof value.eof !== 'boolean'
    || typeof encoded !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw guestPayloadUnavailable(draftRefusal)
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength > GUEST_DRAFT_READ_MAX_BYTES) throw guestPayloadUnavailable(draftRefusal)
  return { bytes, eof: value.eof }
}
