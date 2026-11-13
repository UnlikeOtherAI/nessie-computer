// The immutable host composes these with its admitted provider/native/resource
// layers. Importing this module starts nothing and registers no operation.
export { createSessionRuntimeLayers, SessionEngineLifecycle, SessionLifecycleError,
  ProviderHost, NativeChildProcesses } from '@nessie/t3-session-source/engine'
export { resolveT3SessionStateDir, SessionStateError } from './paths.js'
export { acquireSessionStateWriter } from './ownership.js'
export { withOwnedSessionState } from './state.js'
export { SessionStateOwner } from './state-owner.js'
export { withSessionExecutionState, type HeldSessionExecutionState } from './execution-state.js'
export { sessionExecutionSettingsLayer } from './execution-settings.js'
export { makeSessionInspectionContext } from './inspection-context.js'
export { makeSessionInspectionLeases, type SessionInspectionLeases } from './inspection-leases.js'
export { withHeldSessionInspectionRuntime, type HeldSessionInspectionRuntime,
  type SessionInspectionRuntime } from './inspection-runtime.js'
export { sessionOperationScope, SessionOperationScopeClosed } from './operation-scope.js'
export { bindSessionControlSlots, bindRetainedCatalogSlots, bindRetainedCatalogHttp,
  isSessionControlRequest } from './slots.js'
export { dispatchSessionRpc, dispatchRetainedHttp } from './dispatch.js'
export { sessionDispatchScope } from './dispatch-scope.js'
export { withRetainedRuntimeSource, type HeldRetainedRuntimeSource } from './retained-source.js'
export { withRetainedCaptureWorkspace, type RetainedCaptureWorkspace } from './capture-workspace.js'
export { withCapturedRetainedRuntime, type CapturedRetainedRuntime } from './retained-capture.js'
export { prepareSessionLaunchTarget, recheckSessionLaunchTarget, PreparedSessionLaunchTarget,
  SessionLaunchTargetRefused } from './launch-target.js'
export { prepareSessionExecutionGraph, recognizeSessionExecutionGraph, HeldSessionExecutionGraph,
  SessionExecutionGraphRefused } from './execution-graph.js'
