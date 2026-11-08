/** Fixed reads from T3 25bf84ab; never SELECT * or enumerate a person's directories.
 * Migration names and exact column selections are checked against committed objects.
 * Extra tables are ignored. Missing columns/tables, views and divergent migrations fail.
 */
export interface CaptureTable {
  readonly name: string
  readonly columns: readonly string[]
  readonly order: string
  readonly where?: string
  readonly codec?: string
  readonly scope?: string
}
const table = (name: string, columns: string, order: string,
  codec?: string, scope?: string, where?: string): CaptureTable =>
  Object.freeze({ name, columns: Object.freeze(columns.split(' ')), order, codec, scope, where })
const projection = (suffix: string, columns: string, order: string, codec: string, scope = 'thread_id') =>
  table(`orchestration_v2_projection_${suffix}`, `${columns} payload_json`, order, codec, scope)

export const legacyThreads = table('projection_threads',
  'thread_id project_id title model_selection_json runtime_mode interaction_mode branch worktree_path ' +
  'created_at updated_at archived_at settled_override settled_at unsettled_at snoozed_until snoozed_at ' +
  'pinned_at auto_settle_disabled_at pin_order_key linked_pull_request_json branch_pull_request_json active_order_key deleted_at',
  'thread_id', undefined, 'thread_id')
export const legacyMessages = table('projection_thread_messages',
  'message_id thread_id role text attachments_json context_json is_streaming created_at updated_at',
  'thread_id, created_at, message_id', undefined, 'thread_id')
export const legacyPullRequests = table('projection_thread_pull_requests',
  'thread_id host repository number url source linked_at snapshot_json stack_json',
  'thread_id, host, repository, number', undefined, 'thread_id')
export const projectTable = table('projection_projects',
  'project_id title workspace_root default_model_selection_json default_thread_env_mode auto_pull favicon_path ' +
  'project_icon_json scripts_json created_at updated_at deleted_at', 'project_id')

export const v2Tables: readonly CaptureTable[] = Object.freeze([
  projection('threads', 'thread_id project_id title default_provider runtime_mode interaction_mode ' +
    'active_provider_thread_id created_at updated_at archived_at deleted_at provider_instance_id',
  'thread_id', 'OrchestrationV2AppThreadJson'),
  projection('runs', 'run_id thread_id ordinal provider provider_thread_id status requested_at completed_at provider_instance_id',
    'thread_id, ordinal', 'OrchestrationV2RunJson'),
  projection('run_attempts', 'attempt_id thread_id run_id attempt_ordinal root_node_id provider provider_thread_id ' +
    'provider_turn_id status provider_instance_id', 'thread_id, run_id, attempt_ordinal', 'OrchestrationV2RunAttemptJson'),
  projection('nodes', 'node_id thread_id run_id parent_node_id root_node_id kind status provider_thread_id ' +
    'provider_turn_id runtime_request_id checkpoint_scope_id started_at completed_at',
  'thread_id, node_id', 'OrchestrationV2ExecutionNodeJson'),
  projection('subagents', 'subagent_id thread_id run_id parent_node_id provider provider_thread_id child_thread_id ' +
    'origin status started_at completed_at updated_at driver provider_instance_id completion_delivery_state',
  'thread_id, subagent_id', 'OrchestrationV2SubagentJson'),
  projection('provider_sessions', 'provider_session_id thread_id provider status model updated_at driver provider_instance_id',
    'provider_session_id', 'OrchestrationV2ProviderSessionJson'),
  table('orchestration_v2_projection_provider_session_bindings', 'provider_session_id thread_id',
    'provider_session_id, thread_id', undefined, 'thread_id'),
  projection('provider_threads', 'provider_thread_id thread_id owner_node_id provider provider_session_id status ' +
    'first_run_ordinal last_run_ordinal updated_at driver provider_instance_id',
  'provider_thread_id', 'OrchestrationV2ProviderThreadJson'),
  projection('provider_turns', 'provider_turn_id thread_id provider_thread_id node_id run_attempt_id ordinal status started_at completed_at',
    'provider_thread_id, ordinal', 'OrchestrationV2ProviderTurnJson'),
  projection('runtime_requests', 'runtime_request_id thread_id node_id provider_turn_id kind status created_at resolved_at',
    'thread_id, runtime_request_id', 'OrchestrationV2RuntimeRequestJson'),
  projection('messages', 'message_id thread_id run_id node_id role streaming created_at updated_at',
    'thread_id, created_at, message_id', 'OrchestrationV2ConversationMessageJson'),
  projection('plans', 'plan_id thread_id run_id node_id kind status', 'thread_id, plan_id', 'OrchestrationV2PlanArtifact'),
  projection('turn_items', 'turn_item_id thread_id run_id node_id provider_thread_id provider_turn_id parent_item_id ' +
    'ordinal type status updated_at', 'thread_id, ordinal, turn_item_id', 'OrchestrationV2TurnItemJson'),
  projection('checkpoint_scopes', 'scope_id thread_id run_id node_id parent_scope_id provider_thread_id kind ' +
    'ordinal_within_parent advances_app_run_count created_at', 'thread_id, scope_id', 'OrchestrationV2CheckpointScopeJson'),
  projection('checkpoints', 'checkpoint_id thread_id scope_id run_id node_id parent_checkpoint_id ordinal_within_scope ' +
    'app_run_ordinal status captured_at', 'thread_id, checkpoint_id', 'OrchestrationV2CheckpointJson'),
  projection('context_handoffs', 'context_handoff_id thread_id target_run_id to_provider_thread_id strategy status updated_at',
    'thread_id, context_handoff_id', 'OrchestrationV2ContextHandoffJson'),
  projection('context_transfers', 'context_transfer_id source_thread_id target_thread_id target_run_id type status ' +
    'source_provider target_provider updated_at source_provider_instance_id target_provider_instance_id',
  'context_transfer_id', 'OrchestrationV2ContextTransferJson', 'source_thread_id'),
  table('orchestration_v2_turn_item_positions', 'thread_id turn_item_id ordinal', 'thread_id, ordinal', undefined, 'thread_id'),
  table('orchestration_v2_projection_metadata', 'projection_name schema_version last_sequence updated_at', 'projection_name'),
  table('orchestration_v2_legacy_imports',
    'thread_id source_updated_at shell_imported_at transcript_imported_at imported_message_count last_error', 'thread_id', undefined, 'thread_id'),
  table('orchestration_events', 'sequence event_id aggregate_kind stream_id stream_version event_type occurred_at ' +
    'command_id causation_event_id correlation_id actor_kind payload_json metadata_json application_event_version',
  'sequence', 'application-event', 'stream_id', "application_event_version = 2 AND aggregate_kind IN ('thread', 'project')"),
])

// Only legacy rows needed by the original importer, from this same authoritative file.
const legacyEligible = `thread_id IN (SELECT thread_id FROM projection_threads AS legacy WHERE
  NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS current WHERE current.thread_id = legacy.thread_id)
  OR EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports AS imported WHERE imported.thread_id = legacy.thread_id))`
export const tablesForLayout = (layout: 'v2-80' | 'legacy-54'): readonly CaptureTable[] => Object.freeze([
  layout === 'v2-80' ? Object.freeze({ ...projectTable,
    columns: Object.freeze([...projectTable.columns, 'pinned_at', 'archived_at']) }) : projectTable,
  ...(layout === 'v2-80' ? v2Tables : []),
  ...[legacyThreads, legacyMessages, legacyPullRequests].map(entry => layout === 'v2-80'
    ? Object.freeze({ ...entry, where: legacyEligible }) : entry),
])

export const selectCaptureRows = (entry: CaptureTable): string =>
  `SELECT ${entry.columns.join(', ')} FROM ${entry.name}${entry.where ? ` WHERE ${entry.where}` : ''} ORDER BY ${entry.order}`
