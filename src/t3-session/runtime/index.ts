// The immutable host composes these with its admitted provider/native/resource
// layers. Importing this module starts nothing and registers no operation.
export { createSessionRuntimeLayers, SessionEngineLifecycle, SessionLifecycleError,
  ProviderHost, NativeChildProcesses } from '@nessie/t3-session-source/engine'
export { resolveT3SessionStateDir, SessionStateError } from './paths.js'
export { acquireSessionStateWriter } from './ownership.js'
export { withOwnedSessionState } from './state.js'
export { sessionOperationScope, SessionOperationScopeClosed } from './operation-scope.js'
export { bindSessionControlSlots, bindRetainedCatalogSlots, isSessionControlRequest } from './slots.js'
