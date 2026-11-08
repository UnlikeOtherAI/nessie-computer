# Original session control adapters

This is source implementation for the executor-owned T3 writer, not an installed
capability. The runtime, custody, gateway and UI/tool registrations remain required.
It starts no T3 server, provider, scheduler, database or independent command queue.
T3 remains a source even when its provider is Codex or Claude. Native associations
and native-client controls keep their separate identities and authority.

## Original writer and transport seam

`src/coding-session/t3-control.ts` is the narrow bridge integration entry. The
runtime owner evaluates `executeSessionControl(request, provenance)` in its
existing admitted writer graph. `request` is the original method-correlated
`ExecutorT3Request` subset. `provenance` is the original
`Threads.ThreadManagementProvenance`, stamped from the admitted caller rather
than accepted from tool arguments. Neither value is evidence of authority.

Before evaluation, the owner must validate the signed delivery, selected team,
original source/session ownership, exact environment and runtime generation,
and every target returned by the canonical `requestTargets` resolver. Revalidate
at execution/publication. Preserve the same SQL, per-thread command executor,
outbox and provider/native custody owners; do not construct another graph for
each request. This adapter provides no callback that claims those checks passed.

The source patch derives the dispatch and launch bodies from pinned `ws.ts`,
including original retry selection, message intake, creation provenance helper,
wire projection and typed errors. It removes application startup/analytics and
uses caller-stamped provenance. Every original range binds its prior patched
source hash. The package composes state, client-connection, extraction,
session-control and request-privacy in that order; no second engine is bundled.

| Capability | Canonical operation/input | Original result and retry |
| --- | --- | --- |
| Create | `orchestration.launchThread`, `OrchestrationV2ThreadLaunchInput` | Original thread/projection/resumed/sequence; retry the same command, thread and initial message IDs. |
| Send, queue, steer, restart, fresh context | `orchestration.dispatchCommand`, `message.dispatch` with original `dispatchMode`, `freshContext`, message and command IDs | `OrchestrationV2DispatchCommandResult`; no prompt concatenation or ID allocation in this adapter. |
| Edit/reorder/start/cancel queued work, resume queue | Same method, original `queued-run.*` / `queue.resume` members | Same command receipt; absent attachments in an edit stay absent. |
| Promote queued message to steer | Same method, `queued-message.promote-to-steer` | Retains queued and active run IDs. |
| Stop | Same method, `run.interrupt`; original `orchestration.stopWorkflow` / `orchestration.forceStopThread` | Acceptance does not prove provider stop; force-stop retains its original killed/released/releasing/shared result. |
| Retry preparation | Same method, `prepared-run.retry` | Calls `ThreadLaunchService.retryPreparation`, not raw orchestrator dispatch. |
| Fork, sidechat, merge | Same method, `thread.fork` / `thread.merge_back` | Retains both thread IDs and original run/checkpoint source point; sidechat remains the original flag. |
| Delegate and change wake policy | Same method, `delegated_task.request` / `delegated_task.wake-policy` | Original task/parent IDs, completion policy and engine reactions. |
| Observe completion | Existing original thread/history stream; internal `waitForSessionWork` uses `ThreadManagementWaitInput` | Original `timedOut`, run and `resultRun`, including delegated/background settling. Cancelling the wait does not stop work. |

Public control validation reuses the original request schema, client-command
ledger and target resolver. Internal provider records, delegated completion
acknowledgements/disposals and request answers cannot enter this lane. The
canonical sealed-answer owner supplies sensitive request support separately.
Completion delivery stays with the original reactors; no public operation can
forge completion or replace the original delegated-task state machine.

## Receipts and uncertainty

`observeSessionCommand` reads the real `CommandReceiptStoreV2`; it creates no
receipt table. It requires the admitted exact thread and command type as well
as command ID. A scope mismatch fails without returning the other receipt.
Accepted/rejected receipts retain the original sequence and status. A missing
receipt is `uncertain/receipt_not_observed`; a read failure is
`uncertain/receipt_unavailable`. Neither authorizes a new command ID or proves
non-delivery. Run completion is a separate original projection/wait result.
Launch reconciliation uses its original launch operation because its receipt
workflow can span multiple writes. No direct public receipt RPC is added.

## Schedules remain unbound

`ScheduledTasks.ScheduledTaskService` is the exact extracted required Context
tag and service type. It has no default implementation or exported runtime layer.
`executeSessionSchedule` forwards upsert/setEnabled/delete/runNow to that required
service. `subscribeSessionSchedules` retains its original stream. All five
operations require owner authority, including the subscription; stored task
targets require canonical resolution. The gateway must filter/revalidate before
publication and use bounded stream demand.

The source schedule methods do not take a command ID. A transport command ID
is mandatory and must reach the durable delivery-reconciliation owner before
any mutation, especially `runNow`. This adapter performs no automatic retry.
An ambiguous occurrence cannot be replayed as a new launch. Deleting/pausing
a schedule or cancelling its subscription does not stop previously dispatched
work. Imported schedules and effect queues remain quarantined.

The original `ScheduledTaskService.ts` runtime is deliberately not composed:
it starts scheduling and contains `webhook_secret` persistence, webhook journals,
metrics and unscoped launch dependencies. Required integration is a narrowed
original service implementation with canonical secret save/use, captured owner
authority re-admitted per occurrence, durable run-now reconciliation and the
same admitted writer. Exporting this service declaration is not that binding.

## UI and tool integration

The owning surface is the shared Dev/computer Sessions detail and its composer,
queue, lineage and task controls. UI owners supply those doorways.
`src/t3-session/tools/control.ts` supplies original RPC descriptors and finite
versus stream, grant and retry metadata to WebMCP and internal/external MCP owners.
It registers no tool and advertises no available capability. All registrations
must call the admitted gateway operation, never this local adapter directly.
Schedule streams use bounded resources, not an unbounded tool result. Existing
thread streams provide command/run reconciliation. No statistics, cost, tokens,
quota, billing or telemetry operation is added.

## Qualification

Authoring ran only bounded built-in source generation/composition and TypeScript
syntax stripping, at 128/256 MiB heaps. The seven patch operations compose with
the prior families and request privacy (184 total operations). These probes do
not typecheck imports or execute Effect handlers. No dependency install, compiler,
Turbo task, SQLite test, server, browser or provider has run in this source lane.

With the coordinator's serial heavy window, from the public checkout:

```powershell
$env:T3_SESSION_CONTROL_REFERENCE = 'C:/Users/ondre/Projects/t3code'
$env:NODE_OPTIONS = '--max-old-space-size=5120'
pnpm exec turbo run build typecheck --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
$env:NODE_OPTIONS = '--max-old-space-size=512'
pnpm exec turbo run test:t3-session-control-source test:t3-session-control --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

Use this checkout's own frozen script-disabled dependencies and the registered
engine producer prerequisite. The source gate requires no build and has a 256 MiB
heap. The adapter gate requires the normal build and has a 512 MiB heap. It covers
original intake with explicitly synthetic service endpoints, actual original
SQLite receipt persistence/reopen, uncertain reads and required schedule binding.
Synthetic service tests do not qualify real provider execution or authorization.
Run the normal engine package/strict consumer and request-privacy gates after the
new package build. They require fresh results; historical package hashes do not
qualify the new exports.

Manual acceptance remains pending: selected-team entry, actual T3 and separately
native Codex/Claude controls, all listed controls and recovery paths, original
queue order and IDs, denied/revoked delivery, reconnect/uncertain retries, safe
schedules and delegated completion through UI, WebMCP and internal/external MCP.
No installed or user-facing capability is claimed by this source checkpoint.
