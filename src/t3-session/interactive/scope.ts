import type { EnvironmentId, ThreadId } from '@nessie/t3-session-source/contracts'
import { interactiveOperations, requireInteractive, type InteractiveRequest } from './operations.js'

/** A routing restriction supplied AFTER canonical admission, never a credential.
 * No constructor here can establish original-human continuity or native custody.
 */
export interface InteractiveScope {
  readonly executorId: string
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly connectionEpoch: string
  readonly runtimeGeneration: string
  readonly access: 'read' | 'operate'
  readonly workspace: { readonly cwd: string; readonly worktreePath: string | null }
  readonly terminals: readonly string[]
  readonly tabs: readonly string[]
  readonly devices: readonly {
    readonly hostId: string; readonly deviceId: string; readonly platform: 'ios' | 'android'
  }[]
}

export type InteractiveSource = Pick<InteractiveScope,
  'executorId' | 'environmentId' | 'threadId' | 'connectionEpoch' | 'runtimeGeneration'>

/** Freeze restrictions for the lifetime of one subscription; changing them needs new admission. */
export function snapshotInteractiveScope(scope: InteractiveScope): InteractiveScope {
  return Object.freeze({ ...scope, workspace: Object.freeze({ ...scope.workspace }),
    terminals: Object.freeze([...scope.terminals]), tabs: Object.freeze([...scope.tabs]),
    devices: Object.freeze(scope.devices.map(device => Object.freeze({ ...device }))),
  })
}

export function requireInteractiveSource(scope: InteractiveScope, source: InteractiveSource): void {
  for (const key of ['executorId', 'environmentId', 'threadId', 'connectionEpoch', 'runtimeGeneration'] as const) {
    requireInteractive(scope[key] === source[key], 'resource_mismatch')
  }
}

/** Additional confinement only; call the actual admission service before this check.
 * Closed/absent resources cannot be adopted merely by supplying their IDs here.
 */
export function constrainInteractiveRequest(scope: InteractiveScope, request: InteractiveRequest): void {
  requireInteractive(interactiveOperations[request.method].access === 'read' || scope.access === 'operate',
    'operate_required')
  const input = request.input
  if ('threadId' in input) requireInteractive(input.threadId === scope.threadId, 'resource_mismatch')
  switch (request.method) {
    case 'terminal.open':
    case 'terminal.attach': {
      const terminal = request.input
      // Exact host-resolved workspace; a caller path is never a root grant.
      if (terminal.cwd !== undefined) requireInteractive(terminal.cwd === scope.workspace.cwd, 'resource_mismatch')
      if (terminal.worktreePath !== undefined) {
        requireInteractive(terminal.worktreePath === scope.workspace.worktreePath, 'resource_mismatch')
      }
      if (request.method === 'terminal.open') {
        requireInteractive((request.input.worktreePath ?? null) === scope.workspace.worktreePath, 'resource_mismatch')
      }
      // Provider overlays and arbitrary environment overrides need native credential admission.
      requireInteractive(terminal.providerInstanceId === undefined && terminal.env === undefined,
        'unsupported_operation')
      requireInteractive(scope.terminals.includes(terminal.terminalId), 'resource_mismatch')
      return
    }
    case 'terminal.observe':
    case 'terminal.write':
    case 'terminal.resize':
    case 'terminal.clear':
      requireInteractive(scope.terminals.includes(request.input.terminalId), 'resource_mismatch')
      return
    case 'terminal.close':
      // Upstream omission closes ALL terminals. Never widen an exact resource grant.
      requireInteractive(request.input.terminalId !== undefined
        && scope.terminals.includes(request.input.terminalId), 'resource_mismatch')
      return
    case 'preview.resize':
    case 'preview.adjust':
      requireInteractive(scope.tabs.includes(request.input.tabId), 'resource_mismatch')
      if (request.method === 'preview.adjust') {
        requireInteractive(request.input.clear === undefined, 'unsupported_operation')
      }
      return
    case 'preview.close':
      requireInteractive(request.input.tabId !== undefined && scope.tabs.includes(request.input.tabId),
        'resource_mismatch')
      return
    case 'preview.open':
      // Canonical browser grant, destination policy, profile and allocated tab binding are not available yet.
      requireInteractive(false, 'unsupported_operation')
      return
    case 'device.list':
      requireInteractive(request.input.inspectOnly === true && request.input.retryHostId === undefined
        && request.input.updateTool === undefined, 'unsupported_operation')
      return
    case 'device.open':
    case 'device.close':
    case 'device.detail':
    case 'device.action': {
      const device = request.input
      const hostId = device.hostId ?? 'local'
      requireInteractive(device.deviceId !== undefined && scope.devices.some(
        item => item.hostId === hostId && item.deviceId === device.deviceId,
      ), 'resource_mismatch')
      if (request.method === 'device.open') {
        requireInteractive(scope.devices.some(item => item.hostId === hostId
          && item.deviceId === request.input.deviceId && item.platform === request.input.platform), 'resource_mismatch')
        // Original default boots hardware. Viewing must never cause boot/install.
        requireInteractive(request.input.boot === false, 'unsupported_operation')
      }
      if (request.method === 'device.close') requireInteractive(!request.input.shutdown, 'unsupported_operation')
      if (request.method === 'device.action') {
        // These need additional app/destination/permission grants, not just a device association.
        requireInteractive(!['setPermission', 'openUrl', 'launchApp', 'terminateApp', 'sendPush']
          .includes(request.input.type), 'unsupported_operation')
      }
      return
    }
    case 'preview.list':
    case 'subscribeTerminalMetadata':
    case 'subscribePreviewEvents':
    case 'subscribeDeviceState':
      return // Every result still requires the resource projection before publication.
  }
}
