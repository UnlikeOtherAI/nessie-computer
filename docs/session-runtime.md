# Session runtime composition

Status: authored source, not qualified execution. No provider, native process,
installed session or user data was opened for this change. Production provider
and custody bindings remain required. Constructing a layer is not readiness.

## Composition and ownership

`@nessie/t3-session-source/engine` exports `createSessionRuntimeLayers(state)`.
It uses the existing factory, original Context tags and the exact same `state`
for stores, receipts, projections, outbox and wakeups. The normal split package
keeps Effect external at 4.1.2. No second source resolver, application server,
credential store or provider engine is introduced. Three new core files are
exact entries in `library-inputs.json`.

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
   Requiring these tags does not implement them. `ProviderHost.credentials`
   still exposes T3-owned raw `get/set/remove`; binding that to executor-native
   profiles is prohibited. Its opaque credential-control refactor must land first.
3. Actual `ProviderSessionManagerV2`, directory, turn start/control, requests,
   cleanup, finalization, checkpoints, titles, project/workspace and settings
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
host, native process and cleanup ports. Executor path fixtures reject checkout
state before invoking native permissions.

Only builtin syntax and diff checks have run. Fixtures, compiler, normal package
build, native ACL paths and full startup/shutdown have **not** run. Positive
lifecycle/recovery proof needs real provider/custody owners, a scripted synthetic
protocol child and a coordinator-scheduled heavy window. No actual T3/native
Codex/native Claude journey, WebMCP/MCP acceptance or installed readiness is claimed.

After the coordinator grants a serial window, from the public executor root:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=512'
pnpm.cmd install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir .artifacts/runtime-pnpm-store --child-concurrency=1 --network-concurrency=1
pnpm.cmd exec turbo run test:t3-session-engine --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm.cmd exec turbo run test:t3-session-runtime --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

Use only this worktree's dependencies, source capsule, outputs and store. The
declared producer prerequisite performs its own frozen isolated preparation.
Compiler commands retain their explicit 5120 MiB limit; test processes use at
most 512 MiB. Check the reservation and at least 12 GiB free on Maxis before each
heavy command. This first batch requires no database service, native build,
provider binary, browser or personal profile. The full provider journey is a
separate bounded qualification after native/provider prerequisites integrate.
