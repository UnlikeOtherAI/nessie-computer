# Executor-owned T3 session engine

The normal workspace import is `@nessie/t3-session-source/engine`. Its
[package contract](session-engine-package.md) covers the generated runtime/types,
shared contract identity, frozen producer prerequisite and bounded verification.
It is a machine-only library, with execution owners still required.
The [runtime composition](session-runtime.md) documents ordered lifecycle and
single-writer state source, required native/provider bindings and unrun gates.

The machine-only contract foundation lives in `packages/t3-session-source` and
`packages/protocol/src/t3-session`. It preserves the original 78-file contract
closure and all three upstream contract entries, with Effect 4.1.2 external and
shared ESM chunks. `dist/provenance.json` binds the capsule, selected source,
generated modules, declaration dependencies, transforms and public dependency lock.
TypeScript 5.9.3 checks the original source; declaration barrels preserve source
types with recorded module-suffix changes to avoid TS7056 expansion limits.
Strict NodeNext and Bundler consumers resolve the actual export maps with full
library checking and negative Type/Encoded fixtures. The protocol subpath exports
its built declarations. Model preference fields, provider-refresh side effects,
stored schedule targets and interactive MCP app targets have explicit ledger
policies; no method prefix grants authority. Sensitive ingress remains withheld
until canonical Security persistence and scoped use ports are implemented.

For a final engine co-build, import `@nessie/t3-session-source/build` and use
`sessionContractsAliasPlugin({dependencyDirectory})` with the committed `sessionEngineSourcePlugin`.
Both consume one snapshot, source namespace and dependency root. Do not load an
independently bundled lower-state proof beside a separate contracts candidate.
The method ledger classifies all original operations and leaves implementation
slots unbound. Contract availability does not establish lifecycle, custody,
provider, resource, import, Node 22 or mobile eligibility.

Status: pinned persistence, original read/history/sync extraction and higher
composition over required host ports are implemented as build candidates.
Both the lower-state proof and the higher synthetic SQLite history proof pass;
the generated type boundary passes an ordinary strict TypeScript consumer.
The engine is not an installed executor capability. Lifecycle readiness,
provider execution, the T3 gateway and mobile compatibility remain incomplete.
Corrected qualification uses contracts `4dbabb20` and privacy `fdfdfed2`, with
177 combined operations and manifest SHA-256
`39ce53a11d6b526e1b154fa54fd2e0e50777c3c916b996bb178a26b15ba69a7a`.
The [qualification record](session-engine-qualification.md) distinguishes fresh
gates from the historical `db4bd597` artifacts, which remain rejected as final
privacy evidence. Installed runtime, provider and lifecycle acceptance remain open.
The [independent V05 record](session-engine-v05.md) adds a fresh matching producer
build and actual official Node 22.23.1 import/privacy and SQLite history passes;
the second-output comparison and remaining registered gates are still queued.

This is a machine-only build boundary. It has no member-facing surface. A later
runtime must be reachable through Nessie's selected-team computer/session flow;
this source preparation does not create another doorway or identity authority.

The source-only [T3 client connection patch](t3-session-client-connection.md)
preserves mounted environment URLs through the existing shared URL helpers;
account integration and live client/gateway acceptance remain separate work.

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
The source archive has 2,859 files, is 52,121,600 bytes, and has SHA-256
`6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`.
It includes the three applicable upstream Markdown dependency patches:
`micromark@4.0.2`, `mdast-util-to-hast@13.2.1`, and
`micromark-extension-gfm-table@2.1.1`. Their independent hashes are in the lock.

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

The following helper files are directly importable Node ESM build modules under
`packaging/session-engine/`. They execute no upstream source when imported.

`source.mjs` exports:

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

`snapshot.mjs` exports `readSessionEngineSnapshot(archivePath, spec?)`. It verifies
the complete capsule and parses the Git tar in memory without extracting files.
The frozen result has `identity: {commit, tree, archiveSha256}`, a sorted frozen
`files` array, and `read(path)` returning a fresh Buffer. Source bytes cannot be
changed by mutating a previously returned buffer.

`patches.mjs` exports `applySessionEngineBoundaryPatches(snapshot, manifestBytes?)`.
It binds every ordered patch's complete before/after SHA-256 and unique text
seam; the result preserves the original capsule identity and adds
`orderedPatchesSha256`. `boundary-patches.json` currently redirects one import
in `sourceControl/threadPullRequests.ts` to the same pure
`builtInSourceControlDefinitions` registry. The original application export also
imports all server drivers. This cut preserves normalization behavior without
initializing that driver graph. No domain service is replaced.

`resolver.mjs` exports:

- `createSessionEngineSourceResolver(snapshot)`, with `resolve(specifier, importer?)`
  returning a source/builtin/dependency descriptor and `load(path)` returning
  committed source bytes. Workspace imports use the real package export maps.
- `sessionEngineSourcePlugin({snapshot, dependencyDirectory, dependencies})`, an
  esbuild plugin using the same resolver and an explicit direct-dependency
  allowlist. `t3-source:<committed-path>` selects an exact source entry.

Use a single resolver namespace and dependency root for the eventual contracts
and engine co-build. In particular, use one Effect 4.1.2 singleton. Do not load
two independently bundled candidates into the final runtime as interchangeable
Effect/Context implementations. The isolated library is a qualified dependency
candidate; first-party contract exports and final payload wiring are separate.

## Lower state library and build entry

`core/StateLayers.ts` exports `createSessionStateLayers()` and the source type
`SessionStateServices`. The factory returns `{infrastructure, stores, eventSink,
outbox, layer}`; `layer` requires the real `SqlClient` and supplies the real
application events/receipts, event and command receipt stores, projections,
projects, effect outbox, turn-position store and event sink. Keep those layer
references when adding the worker and orchestration services.

The generated module also exports the original namespaces `ApplicationEvents`,
`ApplicationReceipts`, `EventStore`, `CommandReceipts`, `ProjectionStore`,
`ProjectStore`, `Outbox`, `TurnPositions`, `EventSink`, and the original
`ORCHESTRATION_PROTOCOL_VERSION` (`2`). The Context tags come from the actual
pinned sources. There are no duplicate store implementations or testkit services
in this composition. It opens no SQL database until supplied and built by its
owner, and starts no worker or provider.

The isolated build-only `package.json` and `pnpm-lock.yaml` pin Effect 4.1.2,
the actual shared Markdown pipeline, esbuild 0.25.12, TypeScript 5.9.3, ESLint
10.2.0 and Node 24.12.4 declarations. They do not change executor workspace
dependencies or its runtime/toolchain. Node 22 declarations cannot describe the
source SQLite adapter's newer APIs; the proof ran on Node 24.19.0. The bundle's
Node 22.16 language target does not establish Node 22 runtime compatibility.

From the executor checkout, with the build resource slot reserved:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=1536'
node packaging/session-engine/prepare-dependencies.mjs <read-only-pinned-Git-repository>
pnpm --dir packaging/session-engine install --ignore-workspace --frozen-lockfile --ignore-scripts
node packaging/session-engine/build.mjs --source <read-only-pinned-Git-repository> --output .artifacts/session-engine/state-core.mjs
node packaging/session-engine/build.mjs --source <read-only-pinned-Git-repository> --output .artifacts/session-engine/state-proof.mjs --proof
node packaging/session-engine/proof.mjs .artifacts/session-engine/state-proof.mjs
```

`prepare-dependencies.mjs` materializes only hash-verified upstream dependency
patches under ignored build artifacts. Installs run no package lifecycle script.
`build.mjs` exports `buildSessionStateModule({sourceRepository, outputPath, proof?})`.
It runs strict first-party lint and a strict TypeScript check over the real source
closure before bundling. It rejects server/auth/preview/device/telemetry/provider
driver/credential-store aggregate inputs, unrelated first-party inputs, and all
external runtime imports except Node builtins. Original source remains in the
capsule; no oversized upstream file becomes first-party code or gets a blanket
lint exemption.

The build writes the immutable module, `.provenance.json`, `.licenses.json` and
verified `.source.tar`. Provenance includes original and patched source-file
hashes, authored and bundled dependency-file hashes, ordered patch digest,
dependency lock/build manifest digests, tool versions, bundle size/hash and
whether the entry is the state library or synthetic proof. Original MIT and
bundled dependency notices accompany the module. The proof runner rechecks
artifact/source/lock/patch identity before executing the synthetic entry.

These outputs are build candidates. They do not modify the executor's existing
native manifest, grant personal credentials or bypass native release admission.

## Runtime composition boundary

### Higher source extraction

`patches/t3-session/extraction/generate.mjs` reproduces 124 exact boundary
operations from the verified capsule. Generated modules retain original source
ranges by filename, byte offsets and SHA-256. A range taken after an earlier
refactor also binds the complete preceding patched file hash. Every changed file and
every derived module also has complete before/after hashes. Source implementations
remain immutable capsule inputs. No 15,000-line first-party orchestrator or
replacement history reducer is introduced.

The extraction moves original service declarations into `*.session-port.ts` and
`*.session-api.ts` modules, then makes original application implementations
import/re-export those declarations. Original Context identifier strings and
schema objects remain authoritative. Tag-only consumers no longer import
application settings, native credential stores or provider catalogs.

Original `Orchestrator` read operations move into `OrchestratorReads.ts`;
`ThreadManagementService` read operations move into `ThreadReads.ts`. The full
original services reuse those same functions. This preserves lazy V1 transcript
hydration, inherited history, archived/settled/family selection, search Markdown
parsing, wire projections and history cursors. The extracted `sessionSync.ts`
contains the original websocket module's thread and shell subscriptions,
including pruning/size decisions, replay high-water, coalescing, compact bodies,
synchronized markers and the snapshot/live handoff. It imports no websocket
application or authentication service.

`core/ReadLayers.ts` exports `createSessionReadLayers(state?)`, the actual legacy
importer, narrowed `ThreadReadService`, and source read/sync namespaces. Its layer
requires the owner's SQL service. It starts no effect/continuation consumer,
provider, recovery or mutation admission. Lazy hydration can write imported
history through the real event sink. It does not execute imported work.

`core/EngineLayers.ts` exports `createSessionEngineLayers(state?)` and the actual
Orchestrator, `threadManagementLayer` (`layerWithLegacyImporter`), ThreadLaunch,
recovery, continuation and effect-worker constructors. `ThreadManagementLive.ts`
contains the original real factory and `layerWithLegacyImporter`; the application
reuses them. Its separate default composition supplies a no-op importer, so the
engine graph refuses the entire original `ThreadManagementService.ts` module.
`Threads` exports declarations only. Import smoke checks the actual bundle for
the excluded initializer and imports every usable export without process startup.
Building higher layers starts original scoped orchestration reactions; it is not
the passive read mode. Worker and continuation consumers are explicit returned
layers, not started by the default higher composition. Keep the returned shared
layers: one SQL client, outbox, command executor, continuation queue and allocator
must serve every consumer in one Layer graph.
The shared composition provides its retained state layer to CommandOutputHub;
merging those layers beside each other leaves internal event-sink/projection
requirements unresolved. The synthetic history entry builds this actual shared
composition with passive reads over one SQL client, without higher reactions.

The project-store runtime-policy resolver and authenticated provider-instance
adapter registry are retained. No provider driver implementation is supplied.
Original `ThreadMessageIntake` and attachment-claim functions are exported for the
future admitted operation adapter; public mutations must use them. A transport
must stamp trusted creation provenance and route preparation retry through the
real launch service. Raw Orchestrator dispatch is an internal service, not an
alternative public admission path.

Resource cleanup and finalization observers become required source Context
services, removing their successful empty defaults. The effect executor's type
includes its required cleanup owner. Missing host services fail layer composition;
they do not establish unsupported operations as available.

### Remaining host ports and lifecycle

The following exact original `Service` types are exported as required ports;
there are no dummy implementations in this tranche:

| Port namespace | Required source service and responsibility |
| --- | --- |
| `Settings` | `ServerSettingsService`: `start`, `ready`, serialized settings snapshots/writes and buffered subscriptions; executor-owned durable settings still need implementation. |
| `Config`, `EnvironmentIdentity` | Source paths/configuration and stable `ServerEnvironmentIdentity.getEnvironmentId`; neither selects an installed T3 home. |
| `ProviderDirectory`, `ProviderSessions` | `ProviderInstanceRegistry` and `ProviderSessionManagerV2`: real instance metadata/access and provider session open/control/release/shutdown, with native admission/custody. |
| `Projects`, project/terminal/text source ports | Actual project/workspace, clone/setup, Git, terminal, enrichment and title-generation owners used by `ThreadLaunchService`; shell subscriptions additionally require real project enrichment. |
| `Checkpoints`, `Rollback`, `TurnStart`, `TurnControl`, `RuntimeRequests` | Exact checkpoint and provider execution/control/request service methods consumed by the original effect executor. Their live implementation closure is not substituted or claimed here. |
| `ResourceOwners`, `Finalization`, `Titles` | Cleanup of actual terminal/preview/attachment/scheduled resources, checkpoint finalization/workspace refresh and source title regeneration. All methods require real owners. |
| `SecretRequests` | Exact source `answer`, `savedRef`, `consume`, `saveToFile`, `savePasted` contract. T13 must bind authorized idempotent canonical Nessie vault save and scoped use/delivery, including reference answers and pasted `request_secret(value)`. No `ServerSecretStore`, copied vault or successful storage stub is included. |

The source secret implementation is excluded. Session persistence keeps scoped
references/metadata, never secret values. Vault save and provider delivery have
separate outcomes. Erasing one-use delivery material must not delete the saved
vault entry. The required canonical broker is not implemented by the existing
low-level vault write primitive, and no private service is imported here.

No lifecycle API reports success or readiness. The remaining runtime owner must:

1. Acquire the state writer/custody lease, open the owned database, and await
   real settings startup/readiness and legacy shell reconciliation.
2. Bind real provider, credential, child-process, MCP, workspace and resource
   owners; recover provider runtime state and original delegated work.
3. Start the shared outbox/effect and continuation consumers in scope, resume
   source queues under their original locks, then open mutation admission.
4. On stop, close admission, interrupt consumers, run recovery
   `prepareForShutdown`, prepare and shut down real provider sessions, reconcile
   shutdown state and retain durable failures/unknown descendant custody.

Actual provider-session preparation/shutdown, callback and native stop methods
remain the exact exported source port signatures. A closed transport or child
exit is not stop proof. T05/provider/native bindings and T13's canonical secret
broker are prerequisites for executing those operations, not for passive reads.

### Co-build and portable types

`prepareSessionEngineSnapshot(original, {additionalPatchFamilies?})` applies one
ordered manifest: C02 state, the unchanged T19 capsule client patch family, then
extraction. Additional committed families, including request privacy, append
only when their complete hashes match that preceding source version. Duplicate
family IDs and composition over an already patched snapshot are refused. The
separate web family targets omitted source and is never selected implicitly.

`buildSessionEngineModule({sourceRepository, outputPath, entryPoint?, proof?,
additionalPatchFamilies?, contractsAliasPlugin?})` is additive to `buildSessionStateModule`. T01 may supply
its source-only co-build entry under `packages/t3-session-source/src`; every
authored input is hashed. Engine, contracts, workspace aliases and all first-party
Effect imports use the same source resolver and isolated dependency root. Effect,
platform-node and platform-node-shared are pinned to 4.1.2. Do not dynamically
combine independently bundled candidates.

The producer and T01 alias plugin share `pluginData.nessieSharedEffect === true`
as the dependency-resolution recursion marker. The producer preserves existing
metadata, adds `nessieSharedEffectRoot` for the selected absolute dependency root,
and refuses a conflicting root. A T01 boolean marker without root metadata still
passes through producer resolution once so the selected root is enforced.
Both plugins must receive the same directory.
`plugin-proof.mjs` loads the exact committed T01 helper and runs real esbuild in
both plugin orders. First-party and virtual original imports must share the
actual Schema namespace and codec objects, with one dependency-root module graph.
Both plugins now preserve unrelated plugin metadata and skip resolution only when
the boolean marker and normalized dependency-root marker both match. Contract
`input.mjs` refuses a conflicting root rather than replacing it.

The historical plugin proof defaults to T01 `0f53775`. To qualify a corrected
committed helper, pass the full public commit and SHA-256 of its `input.mjs`:
`pnpm exec turbo run test:t3-session-engine-plugins --root-turbo-json=scripts/turbo.public.json --concurrency=1 -- <capsule> <contracts-commit> <input-sha256>`.
The proof reads Git bytes and checks the digest before executing either order.
`test:t3-session-source --filter=@nessie/t3-session-source` runs the network-free
temporary Git fetch/retry and resolver metadata fixtures. It does not build the
engine. Source cache recovery fetches only a missing exact commit object, keeps
failed work and prior objects, and still verifies the original tree and capsule.

The request owner gates are `test:t3-session-request-source` and
`test:t3-session-request-fixtures` on `@nessie/executor` (public root tasks). Set
`T3_REQUEST_PRIVACY_SOURCE_REPOSITORY` and `T3_REQUEST_PRIVACY_SOURCE_ARCHIVE` to
the verified source and capsule. The source gate first verifies the combined
manifest. The fixture gate declares `test:t3-session-request-prepare`, which
prepares and installs the isolated frozen Effect 4.1.2 dependency with scripts,
workspace and pnpmfile hooks disabled. `test:t3-session-requests` aggregates both.
Registration does not qualify a complete engine composition or canonical vault
port. The source-only correction is committed separately by the privacy owner.

The engine build emits `.mjs`, provenance/licenses, the original capsule, one
`.patches.json` and `.declarations/index.d.ts`. Large upstream inferred schemas
exceed TypeScript 5.9.3 declaration serialization (`TS7056` in `environmentHttp`,
`guestStream`, `orchestrationV2` and `rpc`). Authored declarations therefore refer
to a hash-bound upstream **type-source** tree with ordinary relative imports.
It has no runtime loader and retains exact types rather than flattened schemas.
All source modules receive strict semantic checks with library checking enabled.
The ordinary strict
`tsc` consumer passes with the declared dependencies, no path aliases/custom
compiler host/runtime loader, and library checking enabled. It verifies source
command/secret negatives and required SQL/provider/cleanup port types.

Keep type artifacts beneath the intended dependency root during qualification:

```powershell
node packaging/session-engine/build.mjs --source <pinned-read-only-Git-repository> --output packaging/session-engine/.artifacts/engine.mjs --engine
node packaging/session-engine/consumer.mjs packaging/session-engine/.artifacts/engine.mjs
node packaging/session-engine/build.mjs --source <pinned-read-only-Git-repository> --output packaging/session-engine/.artifacts/history-proof.mjs --engine --proof
node packaging/session-engine/history-proof.mjs packaging/session-engine/.artifacts/history-proof.mjs
node packaging/session-engine/plugin-proof.mjs .artifacts/session-engine/source.tar
node packaging/session-engine/co-build.mjs <pinned-read-only-Git-repository> packaging/session-engine/.artifacts/co-build.mjs <contracts-commit> <privacy-commit> <privacy-manifest-sha256>
node packaging/session-engine/smoke.mjs packaging/session-engine/.artifacts/co-build.mjs
node packaging/session-engine/consumer.mjs packaging/session-engine/.artifacts/co-build.mjs
node packaging/session-engine/history-proof.mjs packaging/session-engine/.artifacts/co-build.mjs --patch-family request-privacy packaging/session-engine/.artifacts/co-build.mjs.request-privacy.json
```

The co-build command executes the current contract alias hook only after its
bytes match the selected committed helper. The consumer runs both Bundler and
NodeNext sequentially with library checking enabled. CoBuildProof is a synthetic
qualification entry exporting the real engine alongside its history/privacy
probes; provenance labels it non-distributable. Use Engine.ts for the eventual
library boundary, subject to its remaining runtime and release qualification.

The co-build command requires explicit committed contract and privacy identities;
it has no default privacy checkpoint. It records the committed T01 source-entry
helper hash and verifies the selected privacy manifest before one application of
state, client, extraction and privacy patches. Changed family bytes require a new
combined digest and qualification artifact.

The history fixture uses actual file-backed SQLite migrations, original importer,
reads, fork planner, event sink, codecs and thread subscription. It creates only
synthetic state, including dormant outbox work whose unchanged row is inspected
before/after reads and reopening. It never uses an installed provider, credential
or retained database. This source includes the fixture; actual pass evidence is
recorded separately below. Node 24 qualification does not establish packaged
Node 22 compatibility: the reader path additionally checks `isTransaction` and
`setAuthorizer`, and the source uses SQLite worker/backup APIs.

The workspace now exports the generated engine library; it is not an npm or
installed-runtime release. Consumers use the package export and its declared
Turbo build prerequisite. Synthetic probe paths are not consumer APIs.
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

On Windows Maxis, nine focused source tests passed with a 1.5 GiB heap limit.
The real CLI reproduced the pinned capsule. Checks cover committed versus dirty
working inputs, byte integrity, output conflicts, symlink refusal, malformed
capsules, export resolution, immutable buffers, and ordered patch rejection.

The lower-state library passed lint and the strict TypeScript 5.9.3 check
(693 files) and bundled 154 pinned source modules into 3,141,429 bytes with
SHA-256 `99a59090d9bfbadacf0b646dcea132464330942aae1d387f9aad7f5a6d53e9cd`.
The synthetic proof passed lint/typecheck (810 files), bundled 259 source modules
into 3,348,048 bytes, and had SHA-256
`12d752848ef9882df07cccabce78e2b22ee31717e5309928d17a038ba29999ff`.
Tools were Node 24.19.0, pnpm 10.22.0 and esbuild 0.25.12. Each step ran
sequentially after a fresh headroom check, with at least 6 GiB free and
`--max-old-space-size=1536`.

The proof ran the original SQLite migrations in an isolated in-memory database
and used actual services. Two commands committed two events and two effect rows;
same-ID replay produced no duplicate effect or second wakeup. A failed provider
batch left no receipt, event, projection, effect or live publication. Live
delivery and sequence resume each returned one committed event; the final
sequence was 2. This exercises shared-outbox wakeups, atomic commit/publication,
receipt replay and event cursors. It is not a provider simulation or complete
session synchronization implementation.

That earlier lower-state proof did not cover native builds/installations,
providers/credentials, retained sessions, file-backed recovery, higher history,
original clients, lifecycle or mobile flows. The following proof adds the
bounded synthetic history/read/sync evidence.

### Higher source qualification on Maxis

The new source gate has 13 passing checks, no failures/skips. It covers ordered
family composition/digest identity, derived range integrity, immutable outputs
and explicit rejection of product/auth/preview/telemetry/provider/vault/usage
implementation paths. The engine candidate passes strict TypeScript 5.9.3
(929 files for the co-build proof) and bundles 347 pinned source modules. The runtime dependency closure
contains one Effect 4.1.2 instance and Node builtins only as external imports.
Original `ws.ts` adapts the application's full thread service to the extracted
read-only subscription tag; the engine never imports that websocket application.

The actual supported `history-proof.mjs` entry passed on Windows Maxis with
Node 24.19.0, pnpm 10.22.0 and esbuild 0.25.12. Jobs ran sequentially under
`--max-old-space-size=1536`, after a fresh 10 GiB free-memory guard, with package
lifecycle scripts disabled. The proof uses file-backed source SQLite including
its reader/checkpoint workers, and runs all 80 original migrations.

Observed results:

- 160 synthetic legacy threads from January 2025 plus a fork and child: 162
  catalog rows, 10 archived and 60 settled rows with tied times, retrieved through
  the original 17-row keyset pagination past the shell's newest 25.
- 360 retained messages beyond the initial 200-row window, read across nine
  history pages, a full transcript, original Markdown search, and schema/wire
  encode/decode. Initial project listing exceeded 100 rows.
- The original fork planner/projection retained all 360 source item IDs and its
  separate synthetic fork marker; the family read contained parent, fork and child.
- Real thread subscription replay returned one prior event, a synchronized
  marker, then one commit made during the high-water/live handoff, with no duplicate.
  Future and synthetically pruned cursors returned authoritative snapshots and
  synchronized markers.
- Reopening the same SQLite file preserved all 360 history rows after pruning.
  A second lazy import wrote zero messages. A real dormant outbox row remained
  byte-for-byte unchanged; passive reads added no command receipts. No provider
  service or effect/continuation consumer was started.

The import smoke, ordinary strict consumer and history proof exercised one
co-build artifact with 347 source modules, 929 checked files and 378 portable
declaration/type-source files. It uses actual stores, source constructors/helpers/codecs and synthetic rows/events,
without a replay harness, no-op importer, provider fake or replacement reducer.
The `sqlite` probe observed `setAuthorizer` and boolean `isTransaction` on this
Node 24 runtime. Packaged Node 22, provider execution/custody, canonical vault
save/delivery, shell enrichment streaming, actual installed history handoff,
full startup/shutdown and original-client/mobile journeys remain unqualified.
No broad workspace, server, browser, native, installer or release build ran.

That co-build selected committed T01 `0f53775b804df5558e5a3be6b8a6d6c6f830f638`
and the now-rejected C05 `db4bd5972777bcfae2df4f00f0292581bc17fb97` privacy family.
Its historical 177-operation combined digest is
`1fc7883b9e4d6665a146cee109a38cbf8d39309d9cabf2fa8b12c72d6e8f5c47`,
bundle SHA-256 is
`da87ebf6bf343e110cbdc5e369dd0e0ccde2a9c578a200fb4ea94e74fb7ff1a5`,
and declaration closure digest is
`ba5c1d5c83b173048011f200d27effe4aa65782062c564a05192c30183f29017`.
The extraction manifest SHA-256 is
`d24f1709b6d7c1211d9987179d3fc727ef51e9c54d7c6900a1fceb8f900f1908`;
the isolated lock SHA-256 is
`5929234e78b262af69280bf3ed1c21187665c3acccaab22ee53072f36ab9c97d`.
This establishes source/read/sync and import/type evidence for those selected
bytes. It is not final privacy integration: corrected committed C05 input must
replace that family and pass the same co-build, import, consumer and history gates.

The independent combined-plugin regression uses the exact committed T01 helper
SHA-256 `763ec6d19901614479f8a0d710255dd6cae6c58dde971b29a71c2d53296fe1ed`.
Both plugin orders produce the same bundle SHA-256
`ddbdb025c1de1977621b093a179fec2d0e388ca2bf0e249af8bf0c83aabe3975`,
with 306 Effect source modules and actual shared Schema/codec identity.

The independent default engine at producer checkpoint
`e10c35f3173bad03b31d6b3355a189695dc1c7e0` selects state, client and extraction
only: 151 operations, combined digest
`8787aa945472cda3c4530c7b57f0c191d44a1829ddaf0ebcdccca2e39007383b`.
Its 4,388,954-byte bundle SHA-256 is
`0082ff6f8fb03d074aca3df6bb7cc440dfe04901f706bdad6830b0bf5032faf2`.
Strict checking covers 922 files and 347 runtime source modules. The 373-file
portable declaration closure has digest
`8a69a6412ef9986d45156241485e9578b890d149e17215afb369e001261ab7b6`.
Actual import smoke passes, and ordinary strict Bundler and NodeNext consumers
both pass with library checking enabled. NodeNext was checked with the same
generated consumer using `--module NodeNext --moduleResolution NodeNext`.

The fresh independent history candidate at that checkpoint has bundle SHA-256
`06568f446cff55fea0a07d7567f807234dab21ea3c39a176e113eee74261e6b1`,
3,566,433 bytes, 284 runtime source modules and 854 checked files. It reruns all
80 migrations and the history/replay/reopen outcomes above. It selects no
request-privacy family and therefore makes no privacy qualification claim.
The subsequent producer root-marker enforcement passes the combined-plugin
regression with unchanged emitted proof bytes; its resolver SHA-256 is
`6b1b1f3d61b5fbbe8fe85eed786cf841e7245e4ac7ff36aee58d7246402394b1`.
