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
| `prepare-shutdown` | Complete original plan and admitted conditional write. |
| `runtime-reconcile-shutdown` | `ProviderRuntimeRecoveryService.reconcile('shutdown')`: commits shutdown reconciliation and process-loss transitions. |

## Complete legacy-shell reconciliation

The first action now uses `LegacyV1ThreadImporter.prepareShellReconciliation`
and `reconcileShellsPrepared`. The original queries, repair, import, event
conversion and per-row writer are shared with `reconcileShells`; the ordinary
unprepared method retains its original ordering. The prepared variant encloses
the complete action in the original event sink's outermost transaction.

Preparation runs only fixed SELECTs on the actual writer connection, so its
connection-local TEMP schema is observable. It captures all repair/import
selection, source previews and ordinals, existing projection/import/position
rows, deterministic event slots and schema. The scoped opaque candidate exposes
only a digest, observation time and actual thread/project targets. Source text,
attachments and projection payloads stay private. Invalid stored target identity
or a conflicting event owned by another thread refuses the action.

The original message-search trigger statements are shared before reuse. Only
their exact original definitions are accepted; additional, substituted and TEMP
triggers, unexpected target table kinds and incoming projection/event foreign
keys refuse. The candidate holds at most 256 targets and 4 MiB of encoded input
after the original reads, without a claim of a preallocation bound in those reads.

Consumption burns the candidate before waiting, rechecks the complete input on
the same writer transaction and calls the actual original mutations. A later
failure rolls back earlier imports, positions and events together. Source or
schema changes, copied/closed candidates, ambient transactions, deadline expiry
and escaped writers refuse. No work is truncated or retried.

The original SQLite driver now carries a restrictive statement deadline to each
actual step, including cached statements and a step delayed by WAL admission.
COMMIT rechecks the same window; ROLLBACK remains available after expiry. A late
result remains uncertain. This restriction supplies no mutation permission.

`SessionEngineGraph.legacyShells` builds the planner over the same original
state, memo and scope before provider construction. Lifecycle passes the complete
candidate to the required `withLegacyShellReconciliation` owner, then preserves
the actual prepared writer's result. The generic lifecycle action callback no
longer accepts this action. No enrolled native observer, backend grant or
production authority owner is supplied by the conditional writer itself.

The original process-loss transition cancels pending/running process-bound effects
and requeues running replay-safe effects. Its existing global scope includes
imported rows outside the current launch. An initial `launchThread` admission
cannot be promoted into permission for that entire set. The production producer
must independently establish the actual affected rows and original resource/
operation ownership, then consume current authority for every affected target
before those writes. An inspection descriptor or empty returned summary is not
such evidence. No positive schema/domain or replacement recovery policy is
invented by this consumer boundary.

The [original process-loss row plan](t3-process-loss-plans.md) now exposes exact
scoped inputs and independently matched held native facts. Its low-level
conditional transaction is separate from the still-missing lifecycle permission.

The original `EffectOutbox.reconcileAfterProcessLoss` now encloses both global
UPDATEs in one SQLite transaction. Cancellation, requeueing and trigger effects
roll back together if a statement fails or SQLite rejects COMMIT with the
transaction still open. The original effect-type classifications, row scope,
result counts, timestamp and physical field updates are preserved.
`sql.afterCommit` wakes workers only after the outermost commit;
an enclosing rollback or rolled-back savepoint discards the notification.
Interruption before commit joins transaction cleanup before returning. This fixes
partial recovery and premature notification without supplying lifecycle authority.

The original Node SQLite client's connection routing now uses Effect's existing
SQLite cleanup owner while holding each actual connection's original lock.
Rejected COMMIT runs ROLLBACK on that same connection before releasing it. If
cleanup fails, both failures remain defects and new statements or transactions
refuse the connection until a subsequent acquisition completes cleanup. There
is no reopen, database replacement, row editing or transaction retry. Each
reader/writer connection retains its own cleanup state. An uncertain COMMIT
result remains a failure even if SQLite already committed; cleanup tolerates an
already-ended transaction without inventing rollback or success. Worker
notification is discarded for that uncertain result.

This transaction covers only the outbox transition. Original runtime recovery
first reconciles each runtime projection and commits its events/effects, then
calls this global method. Shutdown preparation also writes restart-continuation
effects. Authorizing or observing the final outbox transaction alone therefore
cannot authorize a complete startup or shutdown action. The same graph, SQLite
owner and Layer memo map must remain in use throughout those original operations.

Protected recovery now retains settings-read failures as
`ProviderRuntimeRecoveryError` at `read-settings`, before selecting projections
or changing any rows. Unavailable settings cannot mean disabled continuations
or an empty recovery set. Successful settings reads retain the original global
and per-project continuation policy.

`prepareForShutdown` also propagates a selected projection or enqueue failure
with its thread ID. It no longer logs a non-interruption failure as successful
preparation. Defects remain failures. Its original concurrency of two remains;
failure interrupts and joins in-flight work, including SQL rollback, before
returning. Continuations already committed by another iteration remain durable;
this is not an atomic transaction across all selected threads and supplies no
automatic retry or permission to repeat them. The original deterministic
command/effect IDs and restart planner remain unchanged.

The lifecycle still runs provider shutdown after a preparation failure. It skips
subsequent reconciliation, retains the failed state and refuses positive stop
completion. An actual disabled setting or successfully read empty selection can
still finish without enqueuing work; a failed observation cannot establish that
result. A positive whole-action authority producer remains required.

## Whole shutdown preparation

`Recovery.prepareShutdownPlan` prepares the entire original selected action in
one readonly transaction. It uses the original project selection and
`restartContinuationRun`, shared with `prepareForShutdown`, and the original
settings/projection codecs. The scoped candidate exposes the selected thread
IDs, exact restart effect/command/run identities and digests. Settings and
projection payloads remain private. Existing effect slots use the same complete
physical-row reader and digest as process-loss plans.
The candidate's `settingsDigest` hashes original codec output, not physical file
bytes; it cannot replace the held resource's native settings digest.

`prepareForShutdownPrepared({ candidate, notAfterMs, notAfterMonotonicMs })`
burns that candidate before async work. The original event sink owns the outer
writer transaction and its deferred publication. The consumer rechecks the
complete settings, selected projections, effects and existing slots under that
writer lock before inserting. It rechecks inputs, existing physical fields and
the actual inserted slots again before commit. Changed membership, conflicting
IDs or changed input refuses the whole transaction. Existing original
continuations stay unchanged; this cannot reset or retry one.

The same original eventless writer and concurrency of two are retained. The
prepared variant encloses the complete group in one transaction; the ordinary
unprepared operation retains its original per-iteration commit behavior. A
prepared second-write failure rolls back the first insert as well and publishes
no worker wake. The original service, error classes and Context identities are
shared across the extracted API and implementation.

Preparing and consuming refuse an ambient SQL transaction. This ensures that
the prepared event-sink batch owns its actual outermost commit, rather than
publishing after a nested savepoint while its parent is still uncommitted.
The preparing Scope retains the consuming child and joins writer waits and
rollback on closure. Copied, closed, consumed and foreign-service candidates
refuse. Absolute and monotonic deadlines are bounded by observation plus five
seconds, checked after lock waits and by the actual INSERT, then before commit.
A late returned outcome stays uncertain and cannot retry that candidate.
The SQL fence restricts allowed restart IDs and expiry; it grants no permission.

The finite path explicitly restores interruption for the original SQLite
transaction acquisition, including while the event sink masks publication.
Commit, rollback and permit-finalizer installation retain their original masks.
Readonly planning has its own five-second interruptible wait even from a masked
shutdown finalizer; unavailable inputs cannot strand cleanup before admission.
The consuming child times out at the remaining wall/monotonic budget and joins
cleanup. A publication mask must not strand scope closure behind a writer lock.

Plans refuse more than 256 selected threads or more than 4 MiB of encoded
settings/projection inputs. This bounds retained plan bytes after original reads;
it does not claim a preallocation limit inside the original projection reader.
Existing slot reads retain the physical reader's separate 256-row/1-MiB bounds.
Nothing is truncated. Trigger, hidden-column, non-table and incoming-FK guards
protect the actual outbox insert as well as its preceding slot read.

`SessionEngineLifecycle.stop` now calls `withSessionShutdownPreparation`, which
prepares the actual candidate before calling the required owner's
`withShutdownPreparation(candidate, writer)`. Its finite writer takes the
owner's consumed deadline and invokes `prepareForShutdownPrepared`; this action
cannot use the generic `withAction` path. A fresh finite Scope also supports
the enclosing graph's shutdown finalizer. Denial, skipping the writer, replay,
escaped callbacks and replacement of an actual failure refuse completion.

This connects the conditional original mutation to the lifecycle. A production
owner is still absent, and the local observation or supplied deadline is not
native/backend admission. The independent complete-action observation,
current permission for every affected target and remaining four lifecycle
actions are still required before activating production execution.

Qualification on 9 November 2026, Maxis/Windows 11, Node 24.19.0, pnpm 10.22.0
and TypeScript 5.9.3: all six public build tasks and 190 runtime, 14 engine,
11 producer and 14 privacy-source tests passed with zero skips. Fifteen new
runtime cases cover whole-plan preparation and the actual lifecycle connection,
including the masked planning timeout. The ordinary composite consumer reaches
77 contract declarations and zero dependency implementations. Source/fixture
lint, caps and whitespace passed. An outside-runner package-interface probe
denied work without writing, wrote the original two-thread continuation set,
refused an escaped writer and preserved existing rows on a fresh plan.

The same run passed actual long-path workspace migration, write, reopen,
competing-owner and cancellation checks. Direct Win32/SQLite probes reproduced
ordinary-path failures and successful extended-path opens without changing ACL
policy. All eight applicable state-security cases passed; two POSIX cases skip
on Windows. The broader 85-case Windows source gate remains red: 51 pass,
27 fail and seven skip. It exposes unavailable original session authority and
four containment failures; these results do not qualify installed execution.
Failed logs, databases and journals remain retained. Evidence is under
`C:\Users\ondre\.local\state\nessie-verification\t3-7a4698a9\shutdown-plan-20261109`.
No new Rust/native build, PostgreSQL or private API/worker compiler, signing,
installation, browser or production journey ran for this boundary.

Failure-policy qualification on 9 November 2026, Maxis/Windows 11, Node 24.19.0,
pnpm 10.22.0 and TypeScript 5.9.3: six public build tasks passed, followed by
175 runtime, 14 engine, 11 producer and 14 privacy-source tests, with zero skips.
The runtime total includes eight original recovery cases over actual SQLite,
event sink and outbox, with synthetic settings/projection inputs. They cover
unavailable settings, original selection/IDs, idempotence, projection failure,
defects, real enqueue refusal, joined concurrent rollback and provider cleanup.
The ordinary composite consumer reaches 77 contract declarations and zero
dependency implementations. Scoped lint, caps and whitespace passed.

A separate package-interface probe refused startup, shutdown reconciliation and
preparation on unavailable settings, selected no projections and preserved every
physical outbox field. An actual disabled setting still completed preparation.
This used synthetic inputs and an external fixture database through the source
ACL helper; it proves neither installed graph authority nor positive execution.
No new native build, PostgreSQL, private API/worker compiler, signed installation
or production flow ran. Five preexisting Markdown style findings remain in this
guide, with zero introduced; its full style check remains unqualified.

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

Initial boundary qualification on Maxis/Windows 11, Node 24.19.0: six public
build tasks and 13 backend
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

`test:t3-session-runtime` also exercises the actual SQLite recovery transaction:
the full effect/status matrix, second-statement failure, deferred foreign-key
failure at COMMIT, outer rollback, savepoint rollback, worker wakeup after the
outermost commit and interruption. Failpoint triggers and failed fixture
databases remain in external test artifacts. These are machine-only SQL tests;
they do not demonstrate an enrolled positive recovery producer.

Connection-interface fault cases also retain a failed rollback across subsequent
acquisitions and check automatic cleanup before reuse. A separate fault after
actual COMMIT proves that committed bytes do not promote an uncertain response
to success or trigger a retry.

Transaction qualification on 9 November 2026, Maxis/Windows 11, Node 24.19.0,
pnpm 10.22.0 and TypeScript 5.9.3: six public build tasks passed. All 155 runtime,
14 engine, 11 source-producer and 14 privacy-source tests passed with zero skips.
The ordinary composite consumed 470 inputs and 77 shared contract declarations,
with zero dependency implementations. Scoped lint and whitespace checks passed.
The reported Markdown command loaded the library rather than its CLI; actual
style results and existing findings are recorded in [row-plan qualification](t3-process-loss-plans.md#qualification-on-9-november-2026).
Compilers stayed serial at 5120 MiB or less; runners used at most
512 MiB.

Separate ordinary package-interface probes exercised successful cancellation/
requeue, second-UPDATE failure and deferred foreign-key COMMIT failure. Failed
transitions preserved every physical row field; after rejected COMMIT a later
transaction succeeded on the same connection. Fixture rows/triggers and all
failed regression logs remain retained. Evidence is copied to
`D:\BuildArtifacts\nessie\t3-7a4698a9-verification\process-loss-20261109`.
This change ran no new private API/worker compiler, PostgreSQL, Rust/native,
provider, browser, signed installation or production journey. Packaged Node 22
remains unqualified; production activation and its lifecycle owner remain unbound.
