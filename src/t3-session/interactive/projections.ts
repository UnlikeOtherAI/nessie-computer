import type {
  DeviceServiceState, PreviewEvent, PreviewListResult, TerminalAttachStreamEvent, TerminalMetadataStreamEvent,
} from '@nessie/t3-session-source/contracts'
import { requireInteractive } from './operations.js'
import type { InteractiveScope } from './scope.js'

/** Apply BEFORE serialization, spooling or publication. No unrelated metadata reaches readers. */
export function terminalMetadataForScope(
  scope: InteractiveScope, event: TerminalMetadataStreamEvent,
): TerminalMetadataStreamEvent | undefined {
  const visible = (value: { readonly threadId: string; readonly terminalId: string }) =>
    value.threadId === scope.threadId && scope.terminals.includes(value.terminalId)
  if (event.type === 'snapshot') return { ...event, terminals: event.terminals.filter(visible) }
  return visible(event.type === 'upsert' ? event.terminal : event) ? event : undefined
}

export function constrainTerminalEvent(
  scope: InteractiveScope, terminalId: string, event: TerminalAttachStreamEvent,
): TerminalAttachStreamEvent {
  const target = event.type === 'snapshot' ? event.snapshot : event
  requireInteractive(target.threadId === scope.threadId && target.terminalId === terminalId
    && scope.terminals.includes(terminalId), 'resource_mismatch')
  if ('snapshot' in event) {
    requireInteractive(event.snapshot.threadId === scope.threadId && event.snapshot.terminalId === terminalId
      && event.snapshot.cwd === scope.workspace.cwd
      && event.snapshot.worktreePath === scope.workspace.worktreePath, 'resource_mismatch')
  }
  return event
}

export function previewsForScope(scope: InteractiveScope, result: PreviewListResult): PreviewListResult {
  return { ...result, sessions: result.sessions.filter(item =>
    item.threadId === scope.threadId && scope.tabs.includes(item.tabId)) }
}

export function previewEventForScope(scope: InteractiveScope, event: PreviewEvent): PreviewEvent | undefined {
  if (event.threadId !== scope.threadId || !scope.tabs.includes(event.tabId)) return undefined
  if ('snapshot' in event) requireInteractive(event.snapshot.threadId === event.threadId
    && event.snapshot.tabId === event.tabId, 'resource_mismatch')
  return event
}

/** Original decoded schema (including host-kind union), never a flattened substitute. */
export function devicesForScope(scope: InteractiveScope, state: DeviceServiceState): DeviceServiceState {
  const visible = (device: { readonly hostId: string; readonly deviceId: string; readonly platform: string }) =>
    scope.devices.some(allowed => allowed.hostId === device.hostId && allowed.deviceId === device.deviceId
      && allowed.platform === device.platform,
  )
  const hosts = new Set(scope.devices.map(device => device.hostId))
  return {
    // Do not spread environment-wide optional fields (notably bootingDevices and hostStatusDetail).
    supportsHostRetry: false,
    supportsToolUpdate: false,
    supportsToolInspection: state.supportsToolInspection,
    hostStatus: state.hostStatus,
    onboardingCompleted: state.onboardingCompleted,
    agentAccessEnabled: state.agentAccessEnabled,
    hubBasePath: state.hubBasePath,
    revision: state.revision,
    hosts: state.hosts.filter(host => hosts.has(host.id)),
    devices: state.devices.filter(device => visible({ ...device, deviceId: device.id })),
    sessions: state.sessions.filter(session => session.threadId === scope.threadId && visible(session)),
    hostStatuses: Object.fromEntries(Object.entries(state.hostStatuses).filter(([hostId]) => hosts.has(hostId))),
    bootingDevices: state.bootingDevices?.filter(device => device.threadId === scope.threadId
      && visible({ ...device, deviceId: device.id })),
  }
}
