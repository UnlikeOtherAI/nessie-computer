# Executor-owned T3 session engine

Status: pinned source preparation is implemented. The session engine is not yet
an installed or available executor capability. No lifecycle, provider execution,
T3 gateway, session import or full mobile compatibility is claimed here.

This is a machine-only build boundary. It has no member-facing surface. A later
runtime must be reachable through Nessie's selected-team computer/session flow;
this source preparation does not create another doorway or identity authority.

## Source and distribution decision

Use MIT T3 source at
[`25bf84ab07f53f141c20239c63e383823a9d5ea0`](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0).
The source's root LICENSE is retained in the capsule and independently hashed.
Its notice is reproduced in `THIRD_PARTY_NOTICES.md`.

The published [`t3@0.1.7` package](https://registry.npmjs.org/t3/0.1.7) is an
8,178-byte executable downloader. Its npm archive has integrity
`sha512-xYwnF28/0pYox9YkwkFKSpdaaIYFm1sVsPxsb0Z6WQobPAxbGp96EDWFkcrvEBd9vYKAceUX43txeiROeTTfNw==`.
It downloads a platform archive and SHA256SUMS at runtime, permits a release-base
override, and is not an embeddable session library. The
[`v0.1.7` release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7)
resolves to `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`, a different source
revision. A shared version string does not establish protocol identity. Do not
use that launcher, a moving global `t3`, or an independently running T3 server as
the executor's implementation.

`packaging/session-engine/source-lock.json` binds the exact Git commit/tree,
selected source archive's SHA-256 and size, and independent SHA-256 hashes of
LICENSE, both package manifests, the workspace file and dependency lockfile.
The source archive is 52,111,360 bytes with SHA-256
`384e1dad4b99825a1cc48b8f7e832a50126993fe256232c0920d9e6a96f9e581`.

The capsule contains server source, shared packages and build metadata. It omits
the mobile, web and marketing applications and all retained local T3 userdata.
It is an offline source input, not a runnable payload or proof that every
runtime dependency has been packaged. Keep source and bundling tools outside
the installed payload. A final module and every runtime dependency must be
bundled into the executor's immutable verified release before launch.

The upstream package manager is pnpm 12.14.0; its lockfile contains multiple YAML
documents. Preserve the original lock bytes. The executor remains on its own
pnpm 10.22.0 toolchain; do not change that toolchain to prepare a source capsule.

## Source preparation API

`packaging/session-engine/source.mjs` exports:

- `T3_SESSION_ENGINE_SOURCE`: frozen source provenance and selected roots.
- `SessionEngineSourceError`: categorical `code`, with no Git stderr or local
  source contents in its message.
- `verifySessionEngineSource(sourceRepository, spec?)`: checks committed tree
  identity, ordinary source files, selected roots and individual input hashes;
  returns `{commit, tree, sourceFiles}`. An explicit spec supports build-tool
  fixtures and never grants runtime authority.
- `prepareSessionEngineSource({sourceRepository, archivePath}, spec?)`: also
  verifies the complete archive before writing it exclusively. An intact
  existing archive is reusable; a conflicting artifact is not overwritten.
  Returns the identity, `archiveSha256`, `archiveBytes` and `reused`.

The supported build-tool entry point is:

```powershell
node packaging/session-engine/source.mjs --source <read-only-pinned-Git-repository> --archive .artifacts/session-engine/source.tar
```

Preparation reads Git objects at the pin, never working files, and disables Git
replacement objects. Dirty/deleted working files therefore cannot substitute
for the source. Source symlinks and submodules are refused. It runs no install
scripts, providers, T3 executables or source files, and performs no network
access. It does not open a database or inspect personal session contents.

## Runtime composition boundary

There is no published standalone session library at this revision. The lack of
an export is a refactoring task, not a reason to substitute a transcript adapter.
The real lower engine seams are:

1. `OrchestrationEventStore.layer` and `OrchestrationCommandReceipts.layer`.
2. `EventStore.layerFromOrchestrationEventStore` and
   `CommandReceiptStore.layerFromApplicationReceipts`.
3. The real projection/project stores, effect outbox and turn-position store.
4. `EventSink.layerFromStores`, which retains atomic commits, receipts,
   sequence allocation, projection updates and publication after commit.

The eventual worker must use the **same outbox layer instance** as the event
sink; worker wakeups are in memory. A second composition is not equivalent.
Higher thread composition must use `ThreadManagementService.layerWithLegacyImporter`
and the real legacy importer; the plain `layer` supplies a no-op importer and
would lose retained-history behavior.

Do not start `runServer` or substitute `layerProduction` wholesale. The server's
private dependency composition reaches auth, usage, telemetry, previews, device
services and credential persistence. `ProviderHost` is an injectable Effect
Context service; `ProviderHostLive` is T3's credential store and must not become
an executor credential authority.

`ChildProcessSpawner` injection covers Codex's factory, but does not cover all
Claude launches: the SDK's spawn callback, POSIX process-group constructor and
history-worker launch/read paths need explicit custody and scoped-history
adapters. Avoid the built-in driver/hydration aggregate, which also introduces
provider probes and install helpers.

An arbitrary host/provider process remains refused while personal protection
is active: `PersonalInferenceGuard` returns
`personal_inference_host_isolation_required` for a host-execution registration.
Passing a personal authority does not remove that fence. The credential store
belongs only to its registered native credential runtime; its token APIs cannot
be wired directly into T3's byte-returning `ProviderCredentials` contract.
Personal-provider admission requires the coordinated native/profile-owner
boundary, source/consent/generation checks, refresh ownership and tree-stop
proof. Keep the current guard intact.

Engine startup must reconcile legacy shells, recover runtime state, recover
delegated tasks, start the effect daemon in scope, then publish readiness.
Shutdown must fail admission, interrupt the worker, prepare and shut down
sessions, reconcile shutdown state, and retain uncertain custody. A child exit
or closed transport is not positive descendant-stop proof. Provider operations
cannot be advertised before that composition and installed admission exist.

New runtime state belongs under the owning executor connection's durable state,
outside checkouts, with independent ownership from existing T3 userdata. Import
and writer handoff are separate work; never open existing T3 userdata as a
second writer.

## Checks and remaining verification

`test:session-engine-source` is a pure Node build-tool gate with no workspace
runtime dependencies. It also runs in the ordinary packaging tests. Through
the public graph:

```powershell
pnpm exec turbo run test:session-engine-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

On Maxis, six focused source tests passed with a 1.5 GiB heap limit. The real
CLI reproduced the pinned capsule and reused its verified output. These checks
cover committed versus dirty working inputs, byte integrity, output conflicts,
symlink refusal and invalid identity/path inputs. They establish source
preparation only. No engine bundle, native build, installation, personal
credential use, retained-session access or client/provider parity was tested.
