// Original cleanup operations retain their original tag, errors and file rules.
// Closing a native resource is delegated to its real owner, never an empty layer.
export { layer as sessionResourceCleanupLayer }
  from 't3-source:apps/server/src/orchestration-v2/ResourceCleanupService.session-live.ts'
export { SessionResourceTargets }
  from 't3-source:apps/server/src/orchestration-v2/SessionResourceTargets.ts'
