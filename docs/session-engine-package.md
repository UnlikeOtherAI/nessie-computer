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

## Package boundary being implemented

The owning export is `@nessie/t3-session-source/engine`, alongside the existing
contracts/settings/relay and build-helper exports. One split build must generate
engine and contracts from the same exact patched snapshot, share portable types,
and leave Effect 4.1.2 external for ordinary consumer resolution. Producer-only
module counts do not establish the consumer's actual physical/runtime identity.
Package runtime, normal consumer identity/history, reproducibility and final-byte
Node 22 qualification remain pending at this checkpoint.

This is a machine-only build/library capability. No UI changes or screenshots
apply. Canonical vault save/use/delivery, admitted provider/resource/lifecycle
owners, installed custody, gateway and original-client/mobile parity remain open.
