# Generated session-engine package

The [T12 control source](t3-session-control.md) adds `SessionControl` and the
required `ScheduledTasks` port through `core/Control.ts`, registered in the exact
authored-input list. It adds the `session-control` patch family before request
privacy. This five-family source needs fresh normal package, consumer and privacy
qualification; the historical four-family results below do not qualify it.

T02C owns private worktree `C:/Users/ondre/.t3/worktrees/Nessie/t3-a1536d78`,
branch `t3/session-engine-runtime-package`, from exact private base
`8eb6f35ddbeb8805130f8ec3b48a149fc6fce6e2`. Its public branch is
`t3/t02c-session-engine-runtime`. Prerequisite merge
`e70d7f3713b35758e4c8dc60276f5e3c7320a3cf` retains indexed
`2bc2a8411c68908586c6df5d3352fb82506a6d60` and V05
`d6f6773783f29fd139d454a5b3fec3b81e89fed4`, including reviewed V04.
The coordinator owns the final private gitlink. The executor licence is a build
cache input because each generated distribution includes it.

## Frozen qualification before package implementation

Windows Maxis used Node 24.19.0, pnpm 10.22.0, TypeScript 5.9.3 and esbuild
0.25.12. All heavy jobs ran sequentially, concurrency one, with a fresh minimum
12 GiB free-memory guard and inherited 1536 MiB heap; the registered protocol
compiler retained its supported 5120 MiB allowance. A plugin launch refused at
11.669 GiB before doing work; a later launch passed at 13.793 GiB.

The producer installed 206 packages into its own frozen, script/workspace/
pnpmfile-disabled dependency tree and store, reporting zero reused packages.
Source preparation read only committed Git objects from the authorized reference
repository. It reproduced the 2,859-file, 52,121,600-byte capsule
`6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`.
No sibling dependencies, artifacts, interpreters or retained state were used.

Two separate co-build invocations produced new outputs A and B. Both checked
929 files with library checks enabled and emitted 4,606,909 runtime bytes:

- Runtime: `20ab998d8b6f0061f34df3e52367c9161bc700827b0a5c4c4aa5bb886cb84c91`.
- 378-file types: `3df975850bb39c1cde6acb0bfd7484707018bae37b80d575e5cd9d27a70cd9b4`.
- Provenance: `10a9beb3bdc5681b1d506efbefdef045b3659978763ba0c3d3e4919b102874f6`.
- Notices: `b3bfb9fbb65ef16a9a654571025c2b9b7ebc0da6174e68d248574b9d3fe4eefa`.

The complete ordered source, dependency and authored input records match between
A and B and the independent V04/V05 evidence. Every emitted type file was
rehashed. These are synthetic CoBuildProof bytes, not the distributable library.
The ordinary strict Bundler and NodeNext consumers passed with library checks,
including original negative types and required SQL/provider/cleanup ports.

The registered request aggregate prepared its own declared frozen Effect 4.1.2
fixture and passed 14 source checks plus all 27 actual-source fixtures, zero
skipped. This includes the logger `params.callId` and native callback NUL checks.
Both registered plugin orders executed the hash-checked committed contract hook,
shared actual Schema/codec objects, and produced
`ddbdb025c1de1977621b093a179fec2d0e388ca2bf0e249af8bf0c83aabe3975`
with one Schema and 306 Effect modules.

The full registered protocol gate used its real public workspace prerequisites
and passed 18 tests, zero skipped. The first run found that the project fixture
used `name` and omitted the original input `commandId`. The corrected fixture
uses `title` and the matching command ID, checks four independent workspace roots
for both create/update, and rejects the unsupported `name` field. Production
schemas and target extraction did not change. Test files now run sequentially.

From the public root, the supported commands are:

```powershell
pnpm.cmd dlx turbo@2.11.10 run test:t3-session-requests --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm.cmd dlx turbo@2.11.10 run test:t3-session-engine-plugins --root-turbo-json=scripts/turbo.public.json --concurrency=1 -- <owned-capsule> 4dbabb20e42ce9b6c8381f64d3e80d43bde912aa bff917e9ce29b6023c3c756ee395672b17545d7d5825a5321a264790f6a37c5e
pnpm.cmd dlx turbo@2.11.10 run test:t3-session-contracts --filter=@nessie/executor-protocol --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

The request commands require explicit `T3_REQUEST_PRIVACY_SOURCE_REPOSITORY` and
`T3_REQUEST_PRIVACY_SOURCE_ARCHIVE`. For a dedicated dlx store use
`--config.store-dir=<owned-store>`; pnpm 10.22 rejects `--store-dir` for dlx.

## Package interface

The gateway source adds `SocketFrameParts` and uses `TerminalOutputProtocol` from
the engine entry. They export the pinned source's multipart socket helpers and
eight-chunk/terminal-byte output window without copying implementations or
starting a server. This export change is source-only and requires a new normal
package build and consumer qualification; the previous package hashes below
do not qualify it. The private gateway consumes the same external Effect root.

The combined 8 November source candidate registers state, client connection,
extraction/runtime, catalog, files, session control, request privacy and workspace
families in that order. Bounded Node 24.19 checks on Maxis applied every exact
patch against pinned Git objects and parsed 131 affected TypeScript modules.
The combined manifest SHA-256 is
`4c923f711eccd2309209f052cc508119229284f40aa348f12da23d60ee72b754`.
Workspace fragments now bind the exact current extraction stage; their earlier
offsets could not be applied to original-capsule bytes in a combined build.
The generator and its fixture use the same normal preceding family composition.
This is source/syntax evidence only. The normal compiler, consumer fixtures,
native custody and user/tool journeys have not qualified this candidate.

The owning export is `@nessie/t3-session-source/engine`, alongside the existing
contracts/settings/relay and build-helper exports. One split build must generate
engine and contracts from the same exact patched snapshot, share portable types,
and leave Effect 4.1.2 external for ordinary consumer resolution. Producer-only
module counts do not establish the consumer's actual physical/runtime identity.
The runtime is `dist/engine.js`; its declaration entry is
`dist/engine-types/index.d.ts`. Engine implementations emit compiler-generated
`.d.ts` files, never copied implementation `.ts` files. This keeps consumer
ES2022, Node typings and unused-symbol checks from recompiling the engine's
internals. The engine entry declares the same `es2023.array` library requirement
as the contract barrels; no executor compiler option changes. Compiler-synthesized
relative imports resolve through the same checked TypeScript host before path
relocation, including directory imports of the contract index. The contract barrels retain
`dist/types/{index,settings,relay}.d.ts` and share their checked, patched
`dist/source/*.ts` with the engine's type-source closure. The generated build
helper at `dist/build/input.mjs` retains the existing `/build` API in a packed
consumer. Its source helper remains unchanged and hash-checkable.

```ts
import { createSessionStateLayers, createSessionReadLayers, Sqlite,
  EnvironmentIdentity, SourceContracts } from '@nessie/t3-session-source/engine'
import { ThreadId } from '@nessie/t3-session-source/contracts'
```

`SourceContracts` is the actual original module namespace shared with the
contracts entry. Keep one `state = createSessionStateLayers()` and pass it to
`createSessionReadLayers(state)` and, when its owners are ready,
`createSessionEngineLayers(state)`. Recreating state would lose the retained
outbox wakeup reference. Import and factory construction open no database and
start no providers, worker consumers, recovery or lifecycle.

The original read layer type remains
`Layer<SessionStateServices | LegacyImporter.LegacyV1ThreadImporter |
ThreadReadService, never, SqlClient.SqlClient>`. Supply the real SQL layer.
`Sqlite.layerFromPath` needs Effect FileSystem and Path; use the declared Node
platform services for a Node host. Calling `getThreadTranscript` additionally
needs `EnvironmentIdentity.ServerEnvironmentIdentity`. Shell streams still need
the original project enrichment port. Higher layers retain their real settings,
provider and cleanup requirements; the package supplies no fallback owners.

The declared `prepare:engine` Turbo prerequisite prepares the verified source
cache and performs only the isolated producer's frozen, script/workspace/
pnpmfile-disabled install. The ordinary `build` task emits one split graph;
Effect and Node platform packages stay external and pinned at 4.1.2. Markdown
runtime dependencies remain bundled from the frozen patched producer. Their
declared public packages also satisfy the portable upstream type-source imports.
The package includes the complete original MIT notice, dependency notices and
unchanged first-party FSL licence. Previous generated output generations are
retained under the owning package's ignored build directory.
Direct package build/typecheck scripts also invoke that same idempotent
preparation before loading compiler dependencies, including in Docker. Turbo
keeps its explicit graph prerequisite; neither path assumes isolated producer
dependencies already exist.

```powershell
pnpm.cmd exec turbo run build --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm.cmd exec turbo run test:t3-session-engine --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

`library-inputs.json` registers the exact authored files admitted to this graph.
Adapters actually co-built into this graph must add each actual owned file to
`authoredInputs` and export their namespace through `core/Engine.ts`; the build
rejects unregistered imports. Ordinary package consumers remain outside this graph.
Admission checks the complete first-party TypeScript program, including erased
type-only imports and authored `.d.ts`, as well as runtime bundler inputs. Both
closures are recorded with file hashes. The focused regression refuses an
unregistered type-only declaration before emit, then passes after registration.
For files outside the existing package/producer/patch roots, register the same
exact paths in the public and private Turbo build/typecheck inputs. Admission
does not silently widen filesystem inputs or cache coverage.
There are no wildcard directories or runtime source loaders. The separate
[T04 source checkpoint](retained-t3-capture.md) consumes the normal package and
adds only a `RequestPrivacy` namespace re-export of the same patched original
shared module in the already registered engine entry. Its updated normal package,
Node 22 and consumer gates remain unrun; all earlier hashes below describe the
historical package. The producer's existing `buildSessionEngineModule` and
`buildSessionStateModule` APIs remain available for their explicit source/probe
uses; probes are never package exports.

The retained-privacy correction registers the reviewed `7567a431` privacy manifest
(`98310d0…a3c9`) and updates the expected four-family composition (`8abd5bb0…b6f1`).
The normal runtime and strict consumer fixtures now explicitly use `RequestPrivacy`.
Syntax and manifest identity checks do not qualify those runtime/type consumers;
their registered normal-package and Node 22 gates must run again.

## Runtime and browser checks

### Original browser client entry (source checkpoint, not yet qualified)

`@nessie/t3-session-source/client` exports the pinned mobile
`buildThreadListV2Items`, `buildThreadListV2ListItems`, `buildArchivedThreadGroups`
and their `ThreadListV2Item`, `ThreadListV2Layout`, `ThreadListV2ListItem`,
`ArchivedThreadGroup` and `ArchivedThreadSortOrder` types. It also exports the
original `OrchestrationV2Projection`, `ThreadHistoryMerge`, `ThreadState`,
`Threads`, `ThreadHistoryController`, `Shell` and `SourceContracts` namespaces.
Use these in the existing mobile Home/catalog and thread screens. Preserve the
original environment/thread IDs, project grouping and selector ordering;
UOA admission and the native Codex/Claude catalog remain separate host inputs.
The shared canonical native catalog operation is `listExecutorSessionCatalog`.

The client entry never imports `/engine`. It participates in the same split
build and strict TypeScript program as the engine and contracts; its real
compiler-generated declarations live at `dist/engine-types/client.d.ts` and
reference the same contract type tree. Effect remains the ordinary external
4.1.2 dependency. Original client telemetry hashing requires the external
`@noble/hashes` 1.8.0; the frozen producer and public locks contain the upstream
integrity and dependency-free snapshot. Browser consumers resolve its browser
export condition. The private consuming workspace must incorporate that same
dependency when the coordinator combines manifests.

`client-source.json` admits eleven exact mobile Git objects from pinned commit
`25bf84ab07f53f141c20239c63e383823a9d5ea0`, tree
`b0ba4dad62fa11e0a1fd21f5d351d75926d7559e`. The producer reads them from its own
verified source cache with Git replacement objects disabled; it never reads the
reference checkout's working files. The mobile source selection follows
top-level declarations and conservative lexical dependencies using the build's
TypeScript parser. Selected function, type and initializer statements retain
their original bytes. Only import/re-export lists and relative module suffixes
change. Unused native hooks and menu adapters are excluded. Unregistered source,
selected native externals, dynamic/type imports and changed bytes fail closed.
The original shared client-runtime packages remain unsliced and use the same
registered patch composition. No reducer is recreated.

`engine.provenance.json` records the mobile manifest identity, selected file
hashes, original statement byte ranges and hashes, plus the reachable client
output graph. That graph rejects server source, authored engine chunks, Node
builtins and platform/native dependencies before output publication. A normal
browser bundle fixture separately resolves all external dependencies. The
client export supplies original factories and selectors, not a second store,
server, identity authority or source-readiness result.

The [finite browser detail host](t3-session-client-connection.md#finite-browser-detail-host)
adds `BrowserThreadHost.open` and the original transport/persistence namespaces.
`clientAuthoredInputs` registers its four exact first-party platform/lifecycle
files for strict lint, compilation, browser graph admission and provenance.
The registry and `client-host` patch families follow the URL family and precede extraction;
it factors original bearer-only factories without acquiring cloud/relay services.
It changes the combined ordered patch digest, so historical qualification hashes
do not apply to this composition.

The normal package `test` includes the client fixtures. The focused gate is:

```powershell
pnpm.cmd exec turbo run test:t3-session-client --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

It retains the normal build prerequisite and tests exact original selector
membership/order, archive groups, shared codecs and Effect controller lifetime,
strict Bundler/NodeNext consumers, browser isolation and extraction provenance
and refusal. These fixtures are **authored, not run** at this source checkpoint.
The coordinator must qualify the combined manifests in the serial heavy window,
then verify the original Home, cold links, account/team changes and recovery
through the real runtime. Historical engine results below do not qualify this
new client entry.

Source checks on Maxis / Node 24.19.0 used a 384 MiB heap: the three builtin
`test/client/graph.test.mjs` cases passed; all eleven supplemental Git hashes and
the pinned tree verified; eleven changed JavaScript modules passed `node --check`
and four TypeScript files passed builtin type stripping. `git diff --check`
passed. Type stripping is syntax evidence only. No dependency installation,
compiler, Turbo, database, server, browser or native work ran for this entry.

### Historical engine qualification

The first normal package gate passed four cases on Node 24.19.0. The final
registered gate passed six cases on the independently downloaded official Node
22.23.1 interpreter, with no skips. It checked actual package exports and their
physical Effect root, exact codec objects and original Context service identity,
strict Bundler/NodeNext declarations and required ports, browser bundle isolation,
and real SQLite history/replay/prune/reopen through the generated library.

Import/factory construction started zero child processes, workers or databases.
The library exports no synthetic proof functions or no-op importer. The history
run completed all 80 migrations, 162 catalog rows, 10 archived, 60 older settled,
360 messages across nine pages and 360 inherited rows. Replay/live handoff each
returned one event with zero duplicates; future/pruned cursors returned snapshots.
Reopening retained all 360 rows; repeat hydration imported zero messages and the
dormant outbox row was unchanged. Providers and effect consumers started: zero.

Node 22's `builtinModules` does not list prefix-only `node:sqlite`, although
`isBuiltin('node:sqlite')` correctly returns true. The build resolver and external
checks now use that API; the focused regression also rejects invented/bare SQLite
names. This fixes producer admission without changing upstream SQLite behavior.
The original adapter still warns that checkpoints use the main connection when
Node 22 lacks `setAuthorizer`; boolean `isTransaction` is present. Installed
runtime/native eligibility remains false.

The owned Node ZIP and EXE SHA-256 values match the exact-version official
checksums: `7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29`
and `f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed`.
Authenticode is Valid for OpenJS Foundation with a timestamp. No interpreter
installation or runtime custody change occurred.

The local-only registered browser gate passed in headless Chrome 156.0.8078.80.
It imports a self-contained browser-platform bundle made from the three actual
package entries; original ID/settings/secret codecs and 119 relay exports work.
The graph rejects engine, Node builtins and Node platform leakage through shared
chunks. No product UI build, page change or screenshot applies. This gate is
absent from ordinary test/CI.

Two independent forced normal builds under Node 22.23.1 reproduced every byte
of all 396 distribution files, including ordered source/dependency/type inputs,
portable declarations, provenance, notices and packed build helpers. Two standard
`pnpm pack` invocations also produced identical 1,701,172-byte archives:

- All distribution file hashes: `c621b094a162d2262d21ae3335fcb39cfd421926fd7bb9ddd51bcaf9f3540b19`.
- Package archive: `9e48fd3bf65fec76b0731b7d50bda6ef13f73610bed48ca0e0fc9481eb733914`.
- Eight runtime modules: `8816354ed76f27cd48053d1860dae6334d0283418afae4d52c5d96980e65e653`.
- Engine entry: `388d68d2c920b1bbf5fdafa49e2b4ecd757e836fa19d88c89de1fd031f6de49a`.
- 295 engine type files: `3ce35177f0c5cf158415a1a8dab310c07a5cdeca96e651094008a9e60062bf63`, sharing 78 contract type files.
- Engine provenance: `15b4e9f0f2b49d5fa34dbab470f77c424c4e21b7799842203b76da2681a434e6`.
- Complete original MIT/97 dependency notices: `b3bfb9fbb65ef16a9a654571025c2b9b7ebc0da6174e68d248574b9d3fe4eefa`.

A fresh consumer installed only the packed archive plus its declared
dependencies and pinned TypeScript/Node typings/esbuild, from its own frozen,
script/workspace/pnpmfile-disabled installation and store. Module observation
hooks return ordinary resolution unchanged and reject any resolved file outside
that installation; `NODE_PATH` is unset. Runtime imports pass with 323 module
files inside the consumer, actual shared codec/Context identities, one physical
Effect root and zero import/factory side effects. Both strict default-host
Bundler and NodeNext programs pass library checks; all 925 source/declaration/lib
files resolve inside that fresh consumer. No parent workspace modules mask a
missing dependency.

The packed build helper actually read the hash-verified original capsule,
resolved its original contract entry and ran real esbuild with both exported
plugins. Actual alias/source codec identity passed. Its file inputs and loaded
modules stayed inside the consumer's own installation; no helper was imported
from the source checkout.

Contained history execution also passed the complete migration/history/replay/
prune/reopen assertions above, with 324 module files inside the installation.
The containment guard first caught the fixture's direct Node filesystem-service
import resolving from the parent workspace. The consumer manifest now declares
`@effect/platform-node@4.1.2` explicitly, alongside Effect and the engine package;
the library had already declared its own platform dependencies. The corrected
frozen install and contained run passed without remapping imports or weakening
the guard. The failed import attempt created no history database. This is a
consumer host-dependency correction, not a runtime fallback or ambient owner.

The final protocol rerun passed all 18 cases on Node 22, with its normal
5120 MiB compiler. Raw HTTP inventory reads the original committed capsule:
the ledger binds original application declarations, while extracted `ws.ts`
changes line locations and is excluded from the runtime graph. Provenance
records `rawHttpSource: original-committed-capsule`; its inventory digest is
`33cc69d4ac118a969ddc66007ad5e260d6f6a4f988dba0af7093ef69ae6b0356`.
Engine/contracts runtime, types and notices are unchanged by this metadata
correction. The final repeated archives above include the corrected inventory.
The contained consumer then installed that exact final archive, rehashed all 396
installed distribution files against the final output map, and reran actual
import/context/codec and fresh SQLite history proofs on Node 22. All passed;
the read run stayed within 324 consumer module files.

Final source gates pass 14 producer cases and two cache/plugin metadata cases;
both real plugin orders retain the expected `ddbdb025` probe and 306 Effect
modules. Focused first-party lint passes ten changed package/fixture modules.
Private CI/image-scope regression passes 20 cases, including partial-image COPY
closure checks. Docker is not available on this Maxis host: Production Image
app/admin/web were not built here. The complete private API
`test:build-declarations` gate remains deferred to V03's prepared prerequisites;
the exact three contract mappings and new engine mapping are source changes,
not a claimed private gate pass.

This is a machine-only build/library capability. No UI changes or screenshots
apply. Canonical vault save/use/delivery, admitted provider/resource/lifecycle
owners, installed custody, gateway and original-client/mobile parity remain open.

The combined request verifier pins integrated producer `15611588af2ffe71b426b3989a7cee0fd66a04d8`
and includes the original client registry and finite host patch families before
extraction. The request-only fixture omits the later workspace family by design;
the full ten-family source probe retains digest
`ee31451828ab5dc42b49ed53fc78f0bc38223908bb8e9069f3096115e8dc2303`.
Neither check qualifies the generated runtime or declarations.
