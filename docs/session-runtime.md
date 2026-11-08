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
custody. These functions mint no runtime generation, rewrite no environment ID,
stamp no historical human ownership and adopt no native home.

## Required integration

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
start providers. These imports require the coordinator-integrated control and
catalog source, absent from this worker's base. They are not a runnable lane yet.

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
Compiler commands retain their explicit 5120 MiB limit; test processes use at
most 512 MiB. Check the reservation and at least 12 GiB free on Maxis before each
heavy command. This first batch requires no database service, native build,
provider binary, browser or personal profile. The full provider journey is a
separate bounded qualification after native/provider prerequisites integrate.
