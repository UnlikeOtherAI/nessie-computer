# Original startup and recovery authority

The protected engine's startup and shutdown writes require their own current
authority. Source retention, a reserve receipt and finite SQL preclaim permission
do not authorize these operations. Production `open` remains refused.

This is a machine-only boundary owned by `SessionEngineGraph.activate` and
`SessionEngineLifecycle.stop`. `SessionLifecycleAuthority` is required before the
runtime layer builds its original execution hosts. There is no default owner or
native/backend positive producer for it. Supplying a parsed graph or admission
object cannot satisfy the Context service.

Five concrete original actions are guarded:

| Action | Original operation and affected state |
| --- | --- |
| `legacy-shell-reconcile` | `LegacyV1ThreadImporter.reconcileShells`: repairs legacy projections and imports missing shells, preview events and turn positions. |
| `runtime-recover` | `ProviderRuntimeRecoveryService.recover`: reads runtime recovery projections, commits reconciliation events/effects and calls the global process-loss outbox transition. |
| `delegated-task-recover` | `Orchestrator.recoverDelegatedTasks`: reconciles app-owned subagents and delegated completion delivery through their actual parent/thread locks. |
| `prepare-shutdown` | `ProviderRuntimeRecoveryService.prepareForShutdown`: may prepare restart continuations for enabled projects. |
| `runtime-reconcile-shutdown` | `ProviderRuntimeRecoveryService.reconcile('shutdown')`: commits shutdown reconciliation and process-loss transitions. |

The original process-loss transition cancels pending/running process-bound effects
and requeues running replay-safe effects. Its existing global scope includes
imported rows outside the current launch. An initial `launchThread` admission
cannot be promoted into permission for that entire set. The production producer
must independently establish the actual affected rows and original resource/
operation ownership, then consume current authority for every affected target
before those writes. An inspection descriptor or empty returned summary is not
such evidence. No positive schema/domain or replacement recovery policy is
invented by this consumer boundary.

`withSessionLifecycleAction` issues a one-use finite Effect for the actual
original action. It refuses skipped operations, repeated invocation, replacement
results and promotion of an original failure to success. The action runs in a
child retained by the finite attempt's Scope. Returning early or retaining the
issued Effect cannot detach a SQL transaction or permit later mutation; closure
interrupts and joins the original work and its cleanup. Original error and
service unions remain explicit.

Shutdown first stops and joins consumers. Refusal of shutdown SQL still permits
the actual provider shutdown/clearance path to run. The refused write remains a
lifecycle failure and cannot become a successful stop receipt. Positive kernel
clearance and ordinary lifecycle state remain separate facts.

Continuation intake and future commands still need their own current command
and effect authority. Permission for one startup action does not authorize an
ongoing queue consumer, provider process, frame, workspace, attachment, secret
read or imported-row recovery. Complete real host construction and signed
installed execution remain unfinished.

The runtime gate `test:t3-session-runtime` includes real original SQLite/outbox
ordering cases and explicitly synthetic authority/host services. It checks
unchanged refused rows, exact one-use original results, escaped and detached
actions, rollback/cleanup joins and provider cleanup after startup refusal.
These tests grant no enrolled production recovery authority. Source-engine and
ordinary composite consumer gates verify the new required service and exports.

Qualified on Maxis/Windows 11, Node 24.19.0: six public build tasks and 13 backend
prerequisite tasks passed, followed by worker/API compilation against the new
declarations. All 133 runtime and 13 engine tests passed with zero skips. The
strict NodeNext/Bundler fixture requires this owner only for executing composition;
the ordinary composite consumer reaches 77 shared contract declarations and zero
dependency implementations. Focused source/test lint and whitespace checks passed.

Outside the test runner, an ordinary package-interface `makeSessionEngineGraph`
activation refused the missing lifecycle owner before opening SQL or constructing
a provider. No enrolled positive owner, startup/recovery mutation, signed install
or provider execution was established. Rust/native sources and database schema
were unchanged by this consumer-boundary change.
