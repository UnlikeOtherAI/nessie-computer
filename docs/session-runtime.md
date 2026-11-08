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
current writer. The passive capture lane below binds its real source, destination
writer and original read graph; it has a separate callback incarnation and no
executing lifecycle. Missing source identity cannot be filled with a storage path,
random root key, capture guess or a `VerifiedT3EffectGrant` that already assumes
a runtime generation.

## Required integration

Exact pinned Codex Stdio, Claude SDK process/history-child interfaces and the
unbound per-operation byte correlation follow [native transport](session-native-transport.md).

An immutable managed executing entry point must supply all the following.
The finite retained lane does not supply these execution prerequisites or add
a CLI command.

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
The callback exposes the held finite-read lane described below. The Windows
tray-to-existing-daemon consumer is implemented in [the retained handoff](retained-runtime-handoff.md);
its actual installed journey remains unqualified.

Signed reads separately require the integrated
`retainedImportOperationBinding(lease, actualDecodedRequest, delivery.requestDigest)`
and `local.authority(lease, binding)`. Their canonical digest, relay HMAC,
correlation/scope and actual local consent must all match. Bootstrap capture or
publication leases cannot authorize arbitrary lane callers. Unsupported requests
with multiple grants must refuse atomically, never union their scopes or emit
partial original results. Retried operation leases keep their fixed deadlines.
The signed `catalogLeases` delivery carrier and retained implementation ceiling
are parent-integrated. Their actual graph binding is described below; private
issuer/replay composition and end-to-end availability remain unqualified.

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

The held runtime adapter now consumes this carrier. The private encrypted
issuer/replay spool must still compose before end-to-end availability. Multi-grant
runtime composition remains unsupported and fails atomically. Native effects
remain unbound. Lane fixtures are authored but unrun; this checkpoint has only
bounded non-evaluating syntax checks, no compiler, native or runtime proof.

## Held finite-read lane

`withCapturedRetainedRuntime(stateDirectory, { challenge, receipt }, use, signal)`
now passes `{ held, graph, storage, lane, signal }` to `use`. `lane` implements
the existing `T3SessionLaneRuntime` interface. The running daemon's transient
registry now attaches it after actual purpose-bound publication and detaches it
before this callback returns. The unused pre-start `options.t3Sessions` injection
has been removed: never wrap a second `serveExecutor` around this callback.
The inherited-pipe tray doorway, cancellation and joined shutdown are documented
in [the retained handoff](retained-runtime-handoff.md). No second transport,
replay queue or engine graph is created. Source registration does not establish
an installed or qualified capability.

`runtime/retained-lane.ts` composes the port inside the original held catalog
callback. It verifies the exact source object and capture generation, actual
writer/file currentness and enrolled executor, API URL, public key and connection
epoch. It creates one callback incarnation only after graph acquisition and
those checks. `describe()` rechecks before returning the source/environment/root
and capture descriptor; closed or lost ownership returns no announcement and
cannot revive that incarnation. Enrollment/source check failure aborts all lane
demand. Existing 20-second physical/local-consent renewal remains in the outer
source wrapper; these checks never extend consent or operation deadlines.

`open(request, signal, delivery)` retains the exact decoded original request and
requires `isRetainedT3LaneOperation(request)`. It snapshots the delivered lease,
refuses anything except one grant before creating a read service, verifies the
canonical request digest, keyed relay digest, correlation, exact routing and
capture generation, then obtains the actual
`local.authority(lease, retainedImportOperationBinding(...))`. That authority
consumes the same held native consent and fresh server checks during the read.
Per-request `graph.createReadService(authority)` shares the already captured
SQL/read services. It does not reopen a source or build another read graph.

The eight finite RPC and five HTTP handlers use `bindRetainedCatalogSlots` /
`bindRetainedCatalogHttp` and the existing original-codec dispatch. They retain
original input/result/error schemas and receipt-none retry semantics. The broker
replays the saved descriptors under their original expiry; runtime neither
renews them nor manufactures a receipt. Recheck failure is a failed operation,
never an empty successful catalog. Streams, controls and native effects refuse
before dispatch, regardless of supplied provenance.

Each operation has a fixed local deadline, including while demand is idle or
the signed exchange is stalled. At most 64 deadline owners exist. Cancellation
closes demand without stopping any provider. A finite reply is exposed only
after its iterator finishes, scoped slots close and source/enrollment/request
checks pass again. The whole lane closes and joins demand before its surrounding
catalog graph drains authority promises, SQL closes and physical consent releases.
`runSessionEffect` preserves cancellation identity; `sessionDispatchScope`
propagates the enclosing abort reason while retaining actual finalizer failures.
Escaped ports refuse reads and cannot retain readiness after callback return.

Four additional authored fixtures cover source/capture substitution, retired
source/writer/graph rejection, real Effect cancellation finalizers and teardown
defects. The graph substitution fixtures are refusal-only, not positive native
authority proof. All remain unrun. Seven changed TS/MJS modules passed builtin
syntax parsing with a 192 MiB heap, plus whitespace and line-cap checks; no
imports, compiler, SQL, tests, native processes or user-facing journey ran.
No shared manifests or tool registrations changed. Combined qualification must
exercise valid publication/read, multigrant refusal, expiry, epoch/source loss,
replay and drained teardown through the actual signed lane and tool doorways.

## Original launch inspection

The extraction gives the original launch a separate scoped
`ThreadLaunchSelection` service. `SessionControl.prepareLaunchTarget(input)`
uses `selectThreadLaunchTargetInput`: only command ID, optional thread ID/reuse,
project ID and model selection. It does not accept, invent or stamp provenance.
`toAdmittedLaunchInput(input, provenance)` retains the original full launch
conversion and takes provenance from authenticated command admission. Selection runs the
original project/clone checks, provider enablement, receipt recovery and ID
allocator. Inspection reads the original stored project shell without queuing
repository enrichment. Scratch normalization remains in authorized launch:
its original helper runs Git and cannot be invoked by inspection. Reusing an
existing empty thread without an accepted receipt is explicitly refused during
inspection because original validation can import its transcript. It stops before
folder allocation, worktree preparation and command acceptance. The same original
selection service retains at most 64 prepared command selections. Its actual launch
reuses the held original ID; a different selection for that command refuses.
Scope release removes only its own record. Original receipt replay still takes
precedence over allocation. This is an internal finite selection, not command
acceptance, native reserve or a signed execution graph.

`runtime/launch-target.ts` holds that selection and the original request privately.
Recheck verifies the exact canonical original request, current state writer,
original target and current configured instance. Inspection decodes the exact
original `CodexSettings` or `ClaudeSettings` through the held original settings
service, retaining the app's `claudeAgent` identity separately from the native
`claude` driver spelling. It neither constructs a provider instance nor resolves
a secret. An unknown/unconfigured driver, disabled instance or changed settings
refuses. Native homes and credential bindings must come from the protected held
resource producer; no `continuationIdentity` is converted into a native home.

The inspection challenge binds all original request targets and current human
initiation. The protected graph receipt must bind the service-held resource,
runtime generation and release. Neither this internal selection nor a retained
read announcement replaces that receipt. `launchDigest` is deliberately absent:
it belongs to the later native preparation receipt over the exact held process
descriptor, after original authorized preparation and before spawning.

Source extraction also selects the original provider session manager, instance
registry and finalization implementation into separate live modules. The real
manager, original event ingestor and checkpoint/finalization layers now share
the same state, allocator, adapter registry and output hub in `EngineLayers`.
Only metric decorators and completion analytics are omitted. The actual registry
factory is exported for admitted construction; its eager startup must not run
during inspection. Native driver, event/turn/resource ownership and per-operation
SDK byte transport still need binding. No empty registry or successful callback
is used as a substitute. Required service types retain the actual provider
directory and native/resource ports; the manager itself is now supplied.

The fixed protected `t3-session-runtime` entry, held execution resource producer,
native graph signing, original adapter serialization and immutable Claude history
entry are not yet composed at this checkpoint. Four config/refusal fixtures are
authored and unrun; they cannot establish positive native authority. Source-only
syntax parsing covered twelve modules at 256 MiB without linking/evaluation.
No compiler, SQL, tests, provider/native launch, install or manual journey ran.
Two additional original-launch fixtures trap accidental project/Scratch probing,
verify selected-ID reuse and escaped-scope refusal, and refuse transcript-dependent
reuse. They are unrun. A builtin source import inventory parsed 204 modules and
found no excluded application/telemetry imports; this is not a typecheck or runtime
qualification.

The actual original `providerSessionId` exists before provider spawn:
`Orchestrator.providerSessionIdFor` uses the original allocator/deriver, the
projection retains it, and `ProviderTurnStartService` forwards it through
`ProviderSessionManager.open` into the original adapter's `openSession`.
Native preparation must bind this actual graph-owned ID alongside the exact
process descriptor. Reserve still has no provider/native IDs. Provider stdout
proves the separate native association; it never allocates the app session ID.

Root's later combined cold-selection build passed strict checks on Maxis,
Node 24.19.0. Its manifest is
`47e16c5fe007e44e7253c150ae5ee6b1390e47bf51bed98c379b947a7b7c3a58`.
The extracted port shares the original `PreparationInput` alias, selection
normalizes explicitly absent optional fields, and the scoped memo-map owner
retains its closed-graph error in the Effect type. This compiler check does
not qualify the executing entry, native provider or installed journey.

The integrated original engine built successfully on Maxis with Node 24.19.0
and strict declaration checks after replaying all patch families. The combined
manifest digest is `8708c678a9a5f524e5cca8f02271b3f7318d3de957c68143eebbc0bef883afe8`.
The shared provider manager declarations are selected from the same original
source for its port and live implementation. This build does not qualify native
custody, installed execution, or production availability. The earlier 20 client
and 11 engine test passes precede these live-layer changes; this revision needs
its own test run.

Cold inspection now builds only the original persistence services, allocator,
clone-state reader and configured settings. It does not construct the full
thread-management service, orchestrator, provider directory, session manager,
workspace preparation, command executor or worker. The original authorized
launch consumes the same `ThreadLaunchSelection` tag and retains its Scratch,
project-enrichment and transcript-dependent validation in the executing branch.
Original command receipt digest/idempotency semantics remain in that branch;
the opaque runtime selection separately checks the full original request.

`makeSessionEngineGraph` owns one Effect scope and explicit memo map. Its
`inspection` and `activate` effects therefore share the original stores,
outbox, allocator and selection table across separate phase builds. `activate`
builds the existing runtime lifecycle/host composition with those same layer
objects. Required original services remain required; none is mocked by the
factory. Closing the owner refuses subsequent builds. Runtime demand must be
interrupted and joined before that owner closes, as in `sessionOperationScope`.
This internal owner is neither an authority grant nor an execution announcement.
The authored-input allowlist registers `core/EngineGraph.ts` explicitly; the
library producer must include it in the normal strict build and declarations.

Three more fixtures cover shared phase selection, closed-graph refusal and the
absence of provenance from inspection while the actual launch conversion keeps
authenticated provenance. Normal TypeScript consumer fixtures assert that cold
inspection requires SQL/settings but not provider directory/session/cleanup.
All new fixtures are unrun. Builtin parsing at 256 MiB parsed 123 composed patched
modules and 11 changed local modules without linking or evaluating application
code. No compiler, tests, SQL, native launch or manual journey ran for this split.

`prepareSessionExecutionGraph(request, delivery, source)` now binds that pure
selection to an actual `T3ExecutionResourceScope`. It checks the full original
request SHA, keyed relay digest, epoch/incarnation, all original targets and
the signed challenge deadline. It decodes the held settings bytes with original
`ServerSettings`, compares them with the selection's live settings and selects
only the service-issued continuation/history/credential HOME references for the
exact original instance and driver. It rechecks before and after dependent
awaits. No home path or credential content is emitted.
Original settings/provider decoder failures become fixed refusal errors; their
diagnostic values cannot escape into a lane error. An authored refusal fixture
checks that boundary; it has not run.

The producer calls `createT3ExecutionNativeClient.graph` directly. The native
service must authenticate its protected graph peer, current source resources,
backend challenge and enrolled signing key. Returned signature, custody and
payload must match the exact requested graph. The opaque `HeldSessionExecutionGraph`
retains the receipt and original selection only in its owner scope.
`recognizeSessionExecutionGraph` compares the later admitted delivery's exact
receipt, HMAC and full request, then rechecks the source/settings/ID selection.
It does not renew receipt expiry or consume reserve/launch authority. Two
additional refusal fixtures reject serialized graph objects and callback-asserted
resource scopes; they are authored and unrun.

The protected startup parser/companion creator and same-resource source snapshot
are parent-integrated at public `893e3b19095b6279545a5a9767cd37e90e83b791`.
This receipt producer is not yet registered as an executing lane.

`withSessionExecutionState(source, storageRoot, use, callerSignal)` recognizes
the real execution resource before opening destination storage. It consumes
`withReadonlySourceSnapshot` without another source connection or transaction.
The shared `withSourceSnapshotView` supplies the original fixed table reads and
HMAC fingerprints. Its complete frozen-legacy fingerprint still includes rows
excluded from the eligible original-v2 import view. Escaped views/iterators refuse.

The destination uses a distinct `execution-state` namespace, an exclusive writer,
one held SQL layer per generation and a durable capture journal outside checkouts.
It applies the existing complete privacy preflight before any row is inserted.
The physical producer commits its source transaction before the journal marks
the destination captured. Captured is neither published nor executing readiness.
The original engine must reconcile legacy shells inside its own shared graph.

On restart, the same source fingerprint reopens the existing destination and
preserves accepted engine writes. An interrupted `capturing` generation was never exposed to the original
engine: retry allocates a fresh stage and preserves the failed journal/artifact.
Once captured, changed source, changed layout or divergent original-v2 frozen
legacy refuses; no automatic recopy replaces execution history. Explicit source
reconciliation is still required for those cases. A fresh runtime incarnation is minted only
after the destination writer lock is acquired. Callback exit invalidates access;
the enclosing original graph must drain before SQL and the writer close.

The storage root is an owner-checked local data location, not the startup's
service enrollment reference and not source authority. This helper does not read
ProgramData enrollment, select a profile registration or expose machine keys.
Two additional fixtures cover source transaction ownership, full legacy baseline,
escaped views and forged-resource refusal; both are authored and unrun. Fixed
entry, full inspect/open registration, admitted SDK serialization, immutable
history child and installed recovery journeys remain unfinished.

Cold inspection now consumes `Settings.ServerSettingsReadService` (the original
`getSettings` type only) and `ProjectClones.ProjectCloneReadService` (the original
`get` type only). The extracted `ProjectCloneState` owns the original Ref map;
its live clone tracker and cold reader use that same layer, rather than a fake
empty tracker. The original clone guard accepts exactly its consumed read shape.
`sessionExecutionSettingsLayer` decodes only recognized held source bytes and
rechecks before and after each original-codec read. It provides no start/update/
subscription methods and never hydrates a provider or credential resolver.

Authorized launch still requires the full original settings service and clone
tracker; these read interfaces do not substitute for either. Existing compiler
fixes from approved parent `ea74232e550657a57efc9169d0d198ef40e094e5` are preserved.
Two added fixtures check the shared clone map and forged-settings refusal. They
are unrun. All 149 patched modules parsed without evaluation; combined manifest
SHA-256 is `345b17a5cbf8913815ac1b482393e72d7612994e0b905bea9d2c1fe14323b9be`.

`makeSessionInspectionContext(source, heldState)` now builds the real cold
original services over the existing destination SQL layer and protected settings
reader. It captures one `makeSessionEngineGraph` owner, returning scoped inspect/
recognize Effects plus that same owner for later admitted activation. It does not
build another engine, clone the source connection or convert passive state into
an executing graph. Inspection selections must retain their own caller Scope
through normal admitted dispatch; a finite pipe call cannot close that Scope
immediately after returning its graph receipt. No lane or CLI registration is
claimed by this internal composition.

Runtime helper declarations now name their exact original Effect results,
errors and required services through exported types. The owned SQL stage names
the error union of the original Sqlite layer instead of an unknown error port.
Native/resource Promise failures become fixed graph/resource refusal errors;
original launch/settings failures retain their typed unions. No service or error
union is widened to make declarations compile.

Root compiled the combined CLI, original engine, protocol and backend on Maxis
with Node 24.19.0: all 15 prerequisite/build tasks passed. The composed original
manifest is `345b17a5cbf8913815ac1b482393e72d7612994e0b905bea9d2c1fe14323b9be`.
Catalog and file wrappers name their original codecs and Effect services; SQL
transaction errors remain explicit. The retained wake uses the actual
`session_views` cadence topic. These compiler results establish neither native
execution nor installed readiness; focused runtime and provider tests continue.

`makeSessionInspectionLeases` retains a separate child Effect Scope for each
original inspection. Its independent timer uses the supplied original admission
resource deadline, not the five-second signing window. Exact retries keep that
deadline; changing it refuses. Parent cancellation, explicit release and owner
closure interrupt and join preparation, native companion cleanup and all demand
before releasing the selection. Native Promise interruption joins the same
pending call, including its positive-clearance cleanup; it never retries a write.
`withRecognized` holds the entire admitted callback and supplies its scoped abort
signal, so a returned target cannot end lifetime tracking before dispatch drains.
The cold context checks challenge source/capture/writer generation against the
actual held imported state before creating the native graph receipt.

This internal owner is not yet a registered lane. Exact ACK metadata and its
shorter canonical parent expiry still require the parent-integrated inspection
lifecycle contract. No command or provider authority is inferred from retaining
the scope. Four refusal/cancellation fixtures are authored and unrun; six changed
modules passed builtin parsing without application evaluation. No compiler,
package tests, native launch or manual journey ran for this checkpoint.
