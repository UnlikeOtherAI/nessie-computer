# Session runtime composition

Status: authored source, not qualified execution. No provider, native process,
installed session or user data was opened for this change. Production provider
and custody bindings remain required. Constructing a layer is not readiness.

## Composition and ownership

`@nessie/t3-session-source/engine` exports `createSessionRuntimeLayers(state)`.
It uses the existing factory, original Context tags and the exact same `state`
for stores, receipts, projections, outbox and wakeups. The normal split package
keeps Effect external at 4.1.2. No second source resolver, application server,
credential store or provider engine is introduced. Runtime core inputs are
explicit entries in `library-inputs.json`.

The extraction now selects the original `ProviderTurnControlService.layer` and
`RuntimeRequestService.layer`, with their original Context tags, projection
checks, interrupt/restart/steer behavior and error guards. They use the same
state graph and required provider session manager. The runtime composes those
live layers; callers no longer implement those two services themselves.

`sessionProviderHostLayer` preserves settings snapshot locking/subscriptions,
background policy and original attachment/sidecar resolution. The extracted
original `ProviderHost` replaces its raw `credentials.get/set/remove` API with
`credentialReference(namespace, bindingId)`. The required native producer is
`ProviderCredentialReferences.resolve`, returning only an opaque binding key
under the original `owner: "provider"` domain. Original auth grouping and its
`withAccess` rules remain intact. Reference lookup grants no execution, login,
profile adoption or credential access. Native custody must implement resolution
against its actual association; no producer is installed in this checkpoint.

Call-site audit at `25bf84ab` corrects that provisional dependency: the original
host method takes two plain strings, but its actual Cursor caller passes
`"cursor"` and a branded `ProviderInstanceId`. Codex's ChatGPT auth calls the
excluded `ProviderCredentialStore` directly with `"codex-chatgpt"` and
`"codex-chatgpt-registration"`, also keyed by `ProviderInstanceId`. That store
hashes the tuple into a T3-owned storage key. Neither original native Codex
client factory nor Claude query transport calls the host credential method.
There is **no authoritative mapping** from that tuple to `nativeId`, native
home keys or auth grouping. The provisional reference lookup must remain
unbound; it must not be implemented with a guessed key or hash. Final runtime
composition must replace it with the integrated verified-grant/native
association producer contract.

T07's finite native-effect producer is `VerifiedT3EffectGrant`, issued by
`createT3EffectAuthorityClient(...).issue(selection, signal)` and consumed by
T03C's `requestT3EffectAuthority(directory, grant, signal)`. Native receivers
must compare the verified grant's issuer origin with the protected directory's
current enrolled origin. `requestDigest` comes from the signed backend offer,
never a local input hash. These source interfaces do not establish that the
private issuer or final native composition has been integrated or qualified.

`sessionResourceCleanupLayer` selects the original cleanup body, retaining its
attachment resolution/deletion, concurrency and error conversion. Required
`SessionResourceTargets` supplies actual `terminals.close({threadId,
deleteHistory:true})`, `previews.close({threadId})` and
`scheduledTasks.deleteForThread(threadId)`. These are ownership integrations,
not authorization callbacks. Native owners must return only after their
required lifetime clearance. No empty cleanup target is provided.

`SessionEngineLifecycle` runs original legacy-shell reconciliation, provider
runtime recovery and delegated-task recovery before continuation intake and the
original effect worker. It builds the continuation consumer against already
built services, not another copy of the dependency graph. The worker has a scoped
startup handoff; unexpected termination fails `awaitFailure` and removes running
status. The supervisor must race its serving scope against that signal.
`assertRunning` checks lifecycle state only; it is not authority.

Stop closes worker/continuation consumers, prepares original restart intents,
shuts down provider sessions, then reconciles persisted state. Failed consumer
or provider cleanup prevents successful reconciliation. Shutdown failures remain
errors, including in scope finalizers. Stop is shared across concurrent callers,
which observe the same result; it is not native process-tree stop proof. Original
cleanup, finalization, checkpoint, request and provider services remain required.
No successful no-op substitute is installed.

The executor's `src/t3-session/runtime` provides the storage boundary:

- `resolveT3SessionStateDir(executorStateRoot, storageKey)` derives a domain-
  separated SHA-256 directory beneath the loaded pairing's canonical state root,
  under `t3-sessions/`. Exact environment IDs stay in records. Both lexical and
  physical checkout ancestors are refused, including linked worktree `.git`
  files. Existing owner-only checks supply POSIX/Windows permissions; this
  entry point accepts no injected permission verifier.
- `acquireSessionStateWriter(directory)` verifies private paths and holds
  `BEGIN EXCLUSIVE` on `server-owner.sqlite`. The lock file is never deleted.
  Directory/lock inode changes, symlinks and hard-linked locks fail closed.
  A failed currentness check remains failed on that handle.
- `withOwnedSessionState(directory, effect)` acquires that writer before opening
  original file-backed SQLite migrations at `state.v2.sqlite`. It checks existing
  database/sidecar shapes and permissions, retains database identity, and
  interrupts scoped work if the database or lock is replaced. Runtime and SQL
  scopes close before the writer. New database files use 0600; Windows still
  requires the existing packaged native permission helper.

The exported lock kernel is not path admission. Production callers use the
executor wrapper after native custody admission. A free SQLite lock says nothing
about descendants left by a previous runtime: recovery is forbidden until the
native owner independently proves their clearance. Transport EOF never releases
custody. These functions rewrite no environment ID,
stamp no historical human ownership and adopt no native home.

`withOwnedSessionState` now provides `SessionStateOwner` to that same graph.
Its `runtimeGeneration` is a new UUID for each successful exclusive writer and
database-file acquisition. It is minted inside the acquisition scope, never
by canonical routing or from a capture/provider ID. `assertCurrent` rechecks the
actual lock and database identity; observed loss is sticky and closed ownership
always refuses. The scope must not publish this incarnation before SQL and the
complete graph acquire successfully. The UUID is not native custody, source
identity, a readiness claim or effect authority.

T07's required `describe()` must compose that held incarnation with the actual
source binding: recognized physical source and exact recheck, current source
owner lease, original environment ID, and the journal's published capture
generation. Those producers must bind the **same** graph. Executing-graph
readiness also requires `SessionEngineLifecycle.phase === "running"` and a
current writer. No complete source-to-writer binding is instantiated on this
checkpoint; therefore no ready announcement is emitted. Missing source identity
cannot be filled with a storage path, random root key, capture guess or a
`VerifiedT3EffectGrant` that already assumes a runtime generation.

## Required integration

Exact pinned Codex Stdio, Claude SDK process/history-child interfaces and the
unbound per-operation byte correlation follow [native transport](session-native-transport.md).

An immutable managed entry point must supply all the following. This checkpoint
registers no CLI command, protocol implementation slot or advertised capability.

1. Native release admission, generation and lifetime custody, with positive
   previous-process-tree clearance before recovery and teardown proof afterward.
   T03C's isolated source is not assumed integrated or qualified.
2. Original `ProviderHost` and `effect/process/ChildProcessSpawner` through the
   admitted native creator, including Codex/Claude SDK/history/PTY paths.
   Requiring the native tag does not implement its protected creator. The
   opaque ProviderHost reference seam is authored; its real custody producer is
   still required. Reuse `startAgentProcess` beneath the original Codex client
   and Claude SDK adapter, not the reduced native driver projections. T03C must
   supply T3-operation-to-`SessionEffectAuthority` admission with exact native
   association, awaited automatic protocol replies, and mandatory positive
   child-tree clearance. Its native-only `requestEffectAuthority` is insufficient.
3. Actual `ProviderSessionManagerV2`, directory, turn start, resource targets,
   finalization, checkpoints, titles, project/workspace and settings
   owners required by the existing engine. The callback endpoint and canonical
   secret broker must be real scoped owners too. No empty registry, `layerTest`,
   default Node spawner or raw credential-store fallback is supplied.
4. The broker/lifecycle owner supplies fresh per-operation admission and connects
   its serving scope to `SessionEngineLifecycle`. Transports share that service;
   an exported Context tag cannot bypass the canonical operation gate. Before
   stop, that owner must close command admission and drain already admitted
   writes. This internal layer does not add a competing command queue.

## Operation handoff to WebMCP and MCP owners

This is internal machine composition, not a new remote operation or tool.
Session operations retain their original RPC/HTTP descriptors, input/result
schemas and finite/stream classification from the existing protocol ledger.
Discovery, dispatch and tool registration remain with their assigned owners.

`src/t3-session/runtime/slots.ts` exports `bindSessionControlSlots(request,
provenance)` and `bindRetainedCatalogSlots(service)`. Both are scoped Effects
returning the existing `ExecutorT3ImplementationSlots`, for the broker's single
`exchangeExecutorT3Operations` / `exchangeT3SessionOperations` lane. They add no
socket, poller or queue. Control registration binds only the exact admitted
request's method; invoke it with that same decoded `request.input`. Another
input object or mutation of the bound envelope is refused. It snapshots through
the original request codec and calls the control owner's `executeSessionControl`
with those exact values and broker-stamped provenance, then validates the
original descriptor's result/error. The four finite controls are
`dispatchCommand`, `launchThread`, `stopWorkflow` and `forceStopThread` under
`orchestration.`. Their original command/receipt semantics are unchanged.

Retained registration wraps the catalog owner's eight finite read handlers.
Its capture/source-owner fences remain in that service; passive reads do not
start providers. Control and catalog source are now parent-integrated. A runnable
read lane still requires the exact operation-bound catalog lease carrier.

`sessionOperationScope<R>()` captures the held graph once. Each invocation
evaluates the unresolved Effect in a joined scoped child. Caller abort interrupts
that child and waits for its finalizers; closing the owning scope refuses later
calls and joins active children before provider/SQL/writer teardown. Broker
admission and native per-operation consumption remain mandatory. These helpers
create no authority and may not be exposed as a bypass around the signed lane.

Startup is scoped acquisition. Stop is finite teardown; repeating it observes
the same success or failure. Neither is an application receipt, provider
acceptance, human grant or native stop receipt. Runtime unavailability is not
evidence that a prior command was never admitted. Retries retain the command ID
and reconcile its atomic engine receipt through the canonical broker. Cancelling
a stream releases demand; it does not stop the runtime.

## Qualification and limits

### Held source and lane demand checkpoint

`withRetainedRuntimeSource(stateDirectory, { challenge, receipt }, use, signal?)`
calls the real `withRetainedImportLocally` producer. Its callback receives the
exact held source, database and physical recheck through `local`; it never
opens another physical reader. A checked exchange every 20 seconds keeps the
55-second JS / 60-second native idle limit from expiring during unrelated waits.
The first failed check aborts dependent demand and remains failed. `checked`
rechecks before and after each dependent await. The wrapper waits for the
callback even after cancellation, then permits the producer to revoke consent
and release the source. Neither consent nor server lease deadlines slide.

`dispatchSessionRpc(request, slots, signal)` and
`dispatchRetainedHttp(request, http, signal)` adapt already admitted handlers
to the existing lane iterator. They preserve original decoded values, method
errors, HTTP status annotations and finite/stream classification. Invalid
values and internal defects fail the iterator. Unbound RPC methods return
`unbound_operation`. They do not echo a request's claimed source sequence,
buffer a stream, retry a command or create authority.
`bindRetainedCatalogHttp(service)` binds the five HTTP handlers to the same
captured operation lifetime as RPC reads.

`sessionDispatchScope` joins active iterators before the graph closes. It
interrupts pending demand on owner closure, caller abort or iterator return,
waits for finalizers, preserves close failures and refuses concurrent pulls.
It does not stop an admitted provider turn. Only pure Effect interruption maps
to the caller's abort reason; a finalizer defect remains a failure. Construct
this scope after graph acquisition so it closes first.

These exports are internal machinery, not a separately registered tool or
transport. T07's one `describe/open` lane remains the doorway; WebMCP and
internal/external MCP use the canonical operation ledger and original receipt
and retry rules. The integrated `withHeldRetainedCatalogGraph` holds the same
callback instead of acquiring source or SQL per request. The authenticated offer
now carries prospective `ThreadManagementProvenance`; absence still refuses
controls, and its presence does not replace the missing executing graph/native
association. Read/import consent supplies no execution authority.

### Durable capture workspace

`withRetainedCaptureWorkspace(stateDirectory, physicalRootKey, use, signal)`
owns one exclusive writer beneath the executor's private external state root.
It opens the real capture journal and original SQLite layer once per generation.
Opaque `t3-capture:v1:` stage references cannot select arbitrary paths. Capture,
original legacy hydration and the held catalog graph reuse that same SQL service;
reopening a stage does not build another layer. The shared database-file check
rejects linked/non-private files and retains sticky file identity. Lock/file loss
aborts the workspace. New stages use exclusive creation; partial files and failed
acquisitions are retained for the existing journal recovery rules.

Callback cancellation drains dependent work before SQL finalizers, journal and
writer close, in that order. Finalizer failures remain errors. Escaped workspace
and stage acquisitions refuse after closure. Callbacks must observe the supplied
signal and await their operations. This workspace owns passive destination bytes,
not the original source or an executing provider session.

`withCapturedRetainedRuntime` composes the real held source callback, this
workspace, original capture/resume and `withHeldRetainedCatalogGraph`. It passes
the exact local source, database and physical recheck into capture, and the joined
source/workspace signal into the held graph. Existing generations use original
fingerprint/high-water recovery; partial captures are never silently replaced.
The handoff accepts only `{ challenge, receipt }`; it obtains
`local.bootstrapAuthority('capture')` after actual signed `consent.commit`
within the held callback. The parent-integrated retained owner supplies the
activation descriptors and checks the real native grant and backend lease.
The authority's capture generation must match the held local generation.
Selected-thread consent is refused before acquiring destination storage: its
finite bootstrap read/publication scope does not authorize whole-source capture
or prove inherited/shared closure. No caller-supplied cold capture lease remains.
Publication must use the graph's existing `publish` with the same callback's separate
`local.bootstrapAuthority('publish')`; capture authority cannot replace it.
No tray consumer or ready announcement is installed.

Signed reads separately require the integrated
`retainedImportOperationBinding(lease, actualDecodedRequest, delivery.requestDigest)`
and `local.authority(lease, binding)`. Their canonical digest, relay HMAC,
correlation/scope and actual local consent must all match. Bootstrap capture or
publication leases cannot authorize arbitrary lane callers. Unsupported requests
with multiple grants must refuse atomically, never union their scopes or emit
partial original results. Retried operation leases keep their fixed deadlines.
The signed `catalogLeases` delivery carrier is still pending parent integration;
these functions alone do not bind `describe/open` or advertise read readiness.

Two workspace fixtures exercise real SQL service reuse, persisted reopen,
competing writer refusal, invalid/duplicate references, escaped handles and
cancellation/drain. They are authored and unrun, and require the same approved
external `T3_RUNTIME_FIXTURE_ROOT` and native permission support as the writer
fixtures. Builtin syntax parsing links no imports and proves none of these paths.

Nine dispatch/lifetime fixtures are authored against the normal package and
unrun. Seven authored files passed builtin syntax parsing without linking
imports. No compiler, runtime or native qualification is claimed.

Authored normal-package fixtures cover competing writers in this and another
process, process-loss release, reopen without unlink, aliases/replacement and
rejection of unbound runtime services. Import/factory checks trap process,
worker and SQLite side effects. Strict Bundler/NodeNext consumers require the
native process, credential-reference and resource-owner ports. Additional
fixtures exercise original request refusals, resource errors and opaque host
references with service doubles; they are not native admission proof. Executor
fixtures cover path refusal, graph identity, cancellation and scope closure.

Only builtin syntax, bounded source extraction/closure and diff checks have run. Fixtures, compiler, normal package
build, native ACL paths and full startup/shutdown have **not** run. Positive
lifecycle/recovery proof needs real provider/custody owners, a scripted synthetic
protocol child and a coordinator-scheduled heavy window. No actual T3/native
Codex/native Claude journey, WebMCP/MCP acceptance or installed readiness is claimed.

Qualification uses ONE coordinator-integrated source graph and producer install,
after all compatible owner patches are integrated. Do not prepare independent
worker installations or reuse sibling dependencies. On that exact integrated
revision, after a granted serial window, the focused commands are:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=512'
pnpm.cmd exec turbo run test:t3-session-engine --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm.cmd exec turbo run test:t3-session-runtime --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

The coordinator owns the combined family order, authoritative hashes and frozen
producer preparation. This worker's extraction manifest is an authored source
checkpoint, not qualified evidence for the final combined graph.
The real writer-incarnation fixture additionally requires
`T3_RUNTIME_FIXTURE_ROOT`, a coordinator-approved private artifact directory
outside all checkouts and durable user state. It uses actual file-backed SQLite
and the existing permission helper, preserves its files, and fails explicitly
when the prerequisite is absent. It has not run.
Compiler commands retain their explicit 5120 MiB limit; test processes use at
most 512 MiB. Check the reservation and at least 12 GiB free on Maxis before each
heavy command. This first batch requires no database service, native build,
provider binary, browser or personal profile. The full provider journey is a
separate bounded qualification after native/provider prerequisites integrate.

## Operation-bound catalog delivery

`isRetainedT3LaneOperation` limits the current lane to the held graph's eight
finite RPC reads and five HTTP reads. `state: ready` only describes that held
read graph and source incarnation. It does not advertise streams, controls or
native execution. The private broker applies this implementation ceiling before
enqueue and offer; target/result policies may narrow it further. Broadening it
requires an explicit runtime capability contract and its actual authority.

The existing signed session lane carries `ExecutorT3LaneDelivery.catalogLeases`
only to the private daemon. Descriptors use the canonical retained-import schema,
with the original request SHA, keyed relay digest, correlation and exact scope.
The receiver bounds their count/bytes, rejects missing operation bindings,
bootstrap purposes, expired descriptors and substituted requests, and freezes a
decoded copy before dispatch. Active retries must retain identical descriptors;
credits cannot extend their expiry. A local deadline cancels demand even while
an exchange is stalled. These checks establish correlation only.
The held runtime must still consume each matching real local native grant through
`local.authority(lease, retainedImportOperationBinding(...))`.

The backend issuer/replay producer, private encrypted spool composition and held
runtime adapter must be integrated before any read is ready. Multi-grant runtime
composition remains unsupported and must fail atomically. Native effects remain
unbound. Three additional lane fixtures are authored but unrun; this checkpoint
has only bounded non-evaluating syntax checks, no compiler, native or runtime proof.
