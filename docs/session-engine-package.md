# Generated session-engine package

T02C owns private worktree `C:/Users/ondre/.t3/worktrees/Nessie/t3-a1536d78`,
branch `t3/session-engine-runtime-package`, from exact private base
`8eb6f35ddbeb8805130f8ec3b48a149fc6fce6e2`. Its public branch is
`t3/t02c-session-engine-runtime`. Prerequisite merge
`e70d7f3713b35758e4c8dc60276f5e3c7320a3cf` retains indexed
`2bc2a8411c68908586c6df5d3352fb82506a6d60` and V05
`d6f6773783f29fd139d454a5b3fec3b81e89fed4`, including reviewed V04.
The coordinator owns the final private gitlink.

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

The owning export is `@nessie/t3-session-source/engine`, alongside the existing
contracts/settings/relay and build-helper exports. One split build must generate
engine and contracts from the same exact patched snapshot, share portable types,
and leave Effect 4.1.2 external for ordinary consumer resolution. Producer-only
module counts do not establish the consumer's actual physical/runtime identity.
The runtime is `dist/engine.js`; its declaration entry is
`dist/engine-types/index.d.ts`. The contract barrels retain
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

```powershell
pnpm.cmd exec turbo run build --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm.cmd exec turbo run test:t3-session-engine --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

`library-inputs.json` registers the exact authored files admitted to this graph.
T04 must add each actual owned adapter file to `authoredInputs` and export its
namespace through `core/Engine.ts`; the build rejects unregistered imports.
There are no wildcard directories or runtime source loaders. T04 is not
implemented here. The producer's existing `buildSessionEngineModule` and
`buildSessionStateModule` APIs remain available for their explicit source/probe
uses; probes are never package exports.

Package runtime, normal consumer identity/history, reproducibility and final-byte
Node 22 qualification remain pending at this implementation checkpoint.

This is a machine-only build/library capability. No UI changes or screenshots
apply. Canonical vault save/use/delivery, admitted provider/resource/lifecycle
owners, installed custody, gateway and original-client/mobile parity remain open.
