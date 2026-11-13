# Original process-loss row plans

This machine-only interface supplies current input evidence for the remaining
lifecycle authority producer. Its home is the original `EffectOutbox`; the
native doorway is the protected execution resource's `inspectProcessLoss`.
Production `open` still refuses. No lifecycle permission, signed receipt or
provider capability is produced here.

## Original selection and transaction

`Outbox.EffectOutboxV2.prepareProcessLoss` reads the entire original affected
set in one readonly SQLite transaction. It selects pending/running process-bound
effects and running replay-safe effects across every thread in the owned
destination. Binary effect-id ordering is shared with the independent native
reader. The original type classifications are unchanged.

The scoped opaque candidate exposes its original observation time, a plan digest
and metadata containing each effect/command/thread/type, transition and row
digest. Payloads and errors remain private. Each row digest uses the existing
fourteen-field `nessie.t3.pending-effect-row.v1` encoding, including physical
legacy lease expiry. The plan hashes JSON
`["nessie.t3.process-loss-plan.v1", [[transition, rowDigest], ...]]`.
Native pending-effect observation and process-loss observation share their
actual row decoder and digest implementation.

`reconcilePreparedProcessLoss({ candidate, notAfterMs, notAfterMonotonicMs })`
consumes that candidate once. Its transaction compares every physical field
and complete affected-set membership before running the original cancellation
and requeue UPDATEs. Both normal recovery and prepared recovery call that same
implementation; neither returns substitute counts or narrows to the launch
thread. Actual affected counts are checked before commit. Unaffected rows can
change without becoming recovery targets; additions/removals or changes to
eligible rows refuse the whole prepared transition.

The preparing Scope retains and joins the consuming SQL child. A copied,
closed, consumed or foreign-outbox object cannot run a transition. Closure
interrupts a connection waiter and joins transaction cleanup. Absolute and
monotonic deadlines cannot exceed the original observation plus five seconds.
The actual SQL checks expiry after writer-lock waits, at each UPDATE and before
commit. A late returned outcome remains uncertain; the candidate cannot retry.
No supplied deadline is itself authority.

## Independent held observation

`T3ExecutionResourceScope.inspectProcessLoss(graph)` uses the existing fixed
resource companion and SYSTEM service. The service checks the actual caller,
current binding and exact previously accepted Graph payload/nonce. It selects
the graph's held captured destination, opens the existing readonly VFS snapshot,
checks its schema and rechecks the native file/resource owners before returning.
No caller path, SQL, thread list or asserted plan is accepted.

The returned strict unsigned facts are `version`, `observedAtMs`, `planDigest`,
`rowCount`, `cancelled` and `requeued`. Raw payload/error bytes never enter that
result. An empty set has its own actual digest and zero counts; it is not a
fabricated successful recovery. A matching digest proves current physical
inputs only. It supplies no parent-command edge, permanent grant claim,
historical change-and-restore proof or permission over imported targets.

`makeSessionInspectionContext.observeProcessLoss` connects these two readers.
It recognizes the original opaque graph/request/delivery before and after the
observation, prepares through the cold graph's already-built original outbox,
and matches the native digest, counts and observation freshness. The same
`state.stage.sql`, graph Scope and Layer memo map remain in use. It returns the
scoped candidate and unsigned facts without activating execution hosts or
constructing a lifecycle owner.

Both readers reject unrecognized/hidden columns, non-table replacements,
persisted outbox triggers and foreign-key references into the outbox. The
actual conditional writer also rejects connection-local TEMP triggers. This
prevents an outbox update from cascading into unplanned rows. The same schema
guard now protects the existing conditional pending-effect claim. Plans are
bounded to 256 rows and 1 MiB of ordered physical
field JSON. The JavaScript reader bounds allocation before returning raw strings;
the native reader checks the accumulated budget before retaining another row.
Oversize/unsupported sets refuse completely, with no truncated or empty plan.
The original unprepared global method retains its existing scope.

## Remaining authority and verification

The required `SessionLifecycleAuthority` is unchanged and still has no positive
production producer. Full original runtime recovery mutates projections/events
before this final outbox transition. Legacy-shell import, delegated-task
recovery and shutdown preparation also require their own complete observations
and current authority. A match between these two readers cannot authorize those
other effects or satisfy the whole lifecycle service.

Use the existing public Turbo `test:t3-session-runtime` and
`test:t3-session-engine` gates with their build prerequisites, the isolated
`DATABASE_URL`, `TZ=UTC` and external `T3_RUNTIME_FIXTURE_ROOT`. Shared fixtures
compare the actual original plan to native row/digest encoding. Runtime cases
cover complete-set matching, scope closure, replay, schema changes, expiry
behind the writer lock, foreign-key/TEMP-trigger side effects and whole-plan
size refusal. The retained cascade probe demonstrates the initial out-of-plan
mutation; the corrected implementation must refuse with both tables unchanged.

On Windows Maxis, the native gates for this reader are locked Cargo tests on
`windows-common/Cargo.toml` filtered to `execution_process_loss` and
`execution_pending_effect`, and `service-windows/Cargo.toml` filtered to
`destination::read`. Check both service and native manifests to verify the
protected transport consumers. These component cases do not prove installed
SYSTEM authentication, an enrolled lifecycle signer or a real provider journey.

## Qualification on 9 November 2026

On Maxis/Windows 11, Node 24.19.0, pnpm 10.22.0 and TypeScript 5.9.3, six public
build tasks passed. Focused Turbo suites passed 167 runtime, 14 engine, 11 source
producer and 14 privacy-source tests, all with zero skips. The ordinary composite
consumed 470 inputs and 77 contract declarations with zero dependency
implementations. Scoped source/fixture lint and this new guide's real
`markdownlint-cli2-bin.mjs` check passed. The touched existing guides retain
14 baseline MD013 findings, with no new findings. The earlier reported Markdown
commands loaded the library entry and did not execute its CLI; those claims are
corrected in this record. The build, test and native results are unaffected.

Locked Cargo gates passed five selected common tests and 13 actual Windows
held-reader tests. Service and native `cargo check` passed. The service still
reports its existing unused launch-home exports/accessors warnings; full native
warning-free qualification remains open. Native reader tests run as components
in the Maxis test process, not as an installed SYSTEM graph/signing journey.

A separate ordinary package-interface probe matched the shared native fixture,
confirmed readonly preparation, recovered both actual rows and refused changed
membership without changing any physical field. The retained initial cascade
probe changed an out-of-plan row; the final probe refused and preserved it.
No fixture was reset to obtain a pass.

Evidence uses `process-loss-plan-*` logs/probes and is copied to
`D:\BuildArtifacts\nessie\t3-7a4698a9-verification\process-loss-plans-20261109`.
Compilers stayed serial at 5120 MiB or less, with runners at most 512 MiB.
The dedicated `DATABASE_URL` was exported, but these gates ran no PostgreSQL
tests. No new private API/worker compiler, provider, browser, signed install or
production journey ran. The inspection-context/native comparison compiles; its
positive installed authenticated path remains unverified. Packaged Node 22,
positive lifecycle authority and full original activation remain unfinished.
