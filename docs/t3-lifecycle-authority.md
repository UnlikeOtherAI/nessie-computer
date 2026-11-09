# Original startup and recovery authority

The protected engine's startup and shutdown writes require their own current
authority. Source retention, a reserve receipt and finite SQL preclaim permission
do not authorize these operations. Production `open` remains refused.

This is a machine-only boundary owned by `SessionEngineGraph.activate` and
`SessionEngineLifecycle.stop`. `SessionLifecycleAuthority` is required before the
runtime layer builds its original execution hosts. There is no default owner.
The complete legacy-shell action now has a finite native/backend consumer; the
other four actions still need their own owners. Supplying a parsed graph or
admission object cannot satisfy the Context service.

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

The SYSTEM resource service now independently reads that complete shell plan
from its already-held destination file. Its fixed SQL is copied from the pinned
original importer; it selects the same repair/import rows, two original preview
queries and ordinals, existing positions/projections/import markers, exact event
slots and complete persistent schema. Only the three original FTS trigger
definitions are permitted. Its separate read authorizer cannot read private
tables, mutate SQL, load extensions or change connection modes. Snapshot handles,
WAL state, resource watches and a five-second observation window are rechecked.

The fixed resource companion accepts only the exact previously bound graph,
with current source and process custody. It returns an unsigned digest, time and
complete actual target list. The same original graph's `observeLegacyShells`
compares those facts with its private candidate before returning either. The
writer checks its own connection-local TEMP schema; a separate native reader
cannot observe that TEMP namespace. Neither side returns raw rows or payloads.
The cross-language fixture is synthetic and checked by both the real original
importer and the actual Windows held-file reader. These unsigned matching facts
grant no lifecycle permission.

### Finite signed shell-action admission

`prepareLegacyShells(graph, notAfterMs)` burns a durable graph/action slot before
the native read, independently reproduces the complete plan, and signs an enrolled
`nessie.t3.execution.legacy-shell-preparation.v1` receipt. Lost, failed or expired
observations cannot create another window. The required original candidate cap
can only shorten the native five-second absolute and monotonic deadline.

The existing authenticated daemon relay's `execution.legacyShells` method restores
the original operation and consumes its current human, source, graph and relay
authority. The backend resolves every indexed target under locks. This is
maintenance of the private owner's explicitly granted whole captured copy,
including indexed tombstones; ordinary transcript reads still exclude deleted
sources. Missing mappings, absent import provenance, changed project/root/capture,
thread-scoped grants or another owner refuse the complete action.

Migration `11007` stores one immutable receipt and exact signed payload per graph.
Repeated requests can return only that same unexpired payload. They cannot change
its targets, receipt, nonce or expiry. `consumeLegacyShells(graph, signedAdmission)`
burns its held attempt before parsing, verifies backend RS256 independently,
rechecks the complete actual plan and source, then durably claims the slot and
nonce before returning the remaining writer window.

`makeSessionLegacyShellHost` connects this path to the same opaque original
candidate and conditional writer. It carries the minimum original monotonic,
native remaining and signed absolute deadline. Cancellation and closure join
the operation; no generic lifecycle permission or provider authority is supplied.
The transport preserves exact signed bytes and never retries uncertain work.

Qualification on 9 November 2026, Maxis/Windows 11, Node 24.19.0 and pnpm 10.22.0:
six public and 13 private build tasks passed; migration `11007` applied to the
isolated PostgreSQL database. All 49 private authority, 221 runtime, 29 broker,
14 engine and 14 request-source tests passed with zero skips. This includes real
database tombstone/read separation, immutable storage and the original SQLite
writer. Scoped lint, code caps and whitespace passed. Native source had already
passed 34 common and 25 resource tests plus the companion check; unchanged native
checks were reused. No signed installation or production journey ran. Production
`open` remains refused until the remaining real lifecycle and provider hosts exist.

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

## Delegated-task recovery failures

Delegated-task recovery now uses one shared original implementation for startup
and the orchestrator. Its original child/parent selection, terminal-status rules,
keyed thread locks, delivery refresh and concurrency of eight are retained.
Failed SQL reads, child-result finalization or completion delivery propagate as
`DelegatedRecovery.DelegatedTaskRecoveryError`. Defects and interruption retain
their original causes; a failed concurrent child interrupts and joins its siblings.
The actual question-dismissal helper also retains failures instead of logging
them as successful recovery. Single-task restart recovery shares the same error
boundary and its service declaration names that error.

This prevents lifecycle startup from publishing running after failed delegated
recovery. It supplies no recovery grant and does not make the whole recovery
pass atomic across already committed commands. Runtime fixtures use the shared
original loop and real keyed locks/SQLite with synthetic selected inputs and
write callbacks. They cover selection failure, concurrent rollback/cleanup,
completion failure, ordinary selection and original defects/cancellation.
Component checks on 9 November 2026, Maxis/Windows 11, Node 24.19.0: the combined
public/private build passed all 15 tasks. The full runtime run passed 225 cases
and exposed one fixture comparing SQLite row prototypes. After that test-only
correction, all five delegated-recovery cases passed in a filtered lifecycle
rerun. Its nine other passing entries are file containers, not executed cases.
The unchanged 225 results were reused; the whole runtime gate was not rerun.
All 14 engine and 14 combined-source cases passed with zero skips. No native or
PostgreSQL implementation changed, and no provider/install/production journey
was established. Remaining action owners and real activation are still required.

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

Each prepared shutdown plan also binds the exact physical TEXT inputs of every
selected original recovery projection, alongside its decoded projection and
settings. A raw payload change invalidates the conditional write even when the
original codecs decode the same value. Candidates expose only per-thread/project
input digests and the original monotonic deadline; raw records remain private.
The independent held-file [input reader](t3-execution-resources.md#independent-pending-effect-observation)
does not itself select the complete action or grant permission.

Recovery-input qualification on Maxis/Windows 11, Node 24.19.0, TypeScript 5.9.3
and pnpm 10.22.0 passed one combined 15-task build, 229 runtime, 14 engine and
14 combined-source cases. Locked Windows checks passed 38 common, 18 service
destination-reader and 11 native source-reader cases, with no ignored cases,
plus native production checking. The ordinary package-interface probe observed
raw TEXT changes, preserved decoded projections and refused stale shutdown with
zero outbox writes. Fixture-only lint corrections reran lint; passing builds and
behavioral suites were not repeated. These synthetic SQLite/held-file checks
establish no installed graph, enrolled lifecycle permission or provider journey.

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
