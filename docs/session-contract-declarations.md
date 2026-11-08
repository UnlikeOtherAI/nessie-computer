# Portable original contract declarations

The three public contract entries and `/engine` share
`dist/types/source/*.d.ts`. The owning package remains
`@nessie/t3-session-source`; the doorways are its ordinary imports and build
commands. This is a machine-only producer change. It changes no runtime
contracts, Queue semantics or product UI.

`contract-names.mjs` names five original inferred types before declaration emit:
`EnvironmentOrchestrationHttpApi`, `GuestStreamEvent`,
`OrchestrationV2ThreadStreamItem`, `OrchestrationV2RpcSchemas` and `WsRpcGroup`.
It retains original Schema/HTTP/RPC constructors and refers to existing schema
values with `typeof`. The RPC group keeps the exact `Rpc.AddMiddleware` result
over every original procedure and its authorization service. It does not replace
schema objects with decoded shapes or change the external Effect package.

A separate compiler program first checks invariant type equality against each
unannotated original inference. The annotated program is then checked and emits
ordinary declarations for the complete engine, client and contract closure.
Assertions and annotations exist only in the compiler host; runtime bundling
still reads the unchanged prepared snapshot. Unsupported type shapes or unequal
annotations fail the producer. TypeScript stays pinned at 5.9.3 with library
checks enabled and the existing 5120 MiB compiler ceiling. No source preparation
family needs regeneration for these type-only annotations.

Original JSON imports remain checked data inputs. The producer emits declarations
for their importing TypeScript modules; it does not request a declaration from
TypeScript for a JSON data module. The engine fixture checks inferred JSON types
and rejects an incompatible annotation, so excluding JSON from declaration emit
does not exclude it from semantic checking or source provenance.

The original Codex client's `Service.raw` interface is exported by name in the
extraction. It was already part of that public service's type. This type-only
export lets `revertCodexThread` name its existing client input during declaration
emit; it adds no runtime entry point or capability.

Protocol generation consumes `/command-inventory` instead of reading removed
`dist/source` implementation files. The producer parses the original internal
command union without evaluating it and records only its literal discriminants,
original module SHA-256 and format. Protocol generation verifies the metadata's
digest and source identity against package provenance before comparing the
complete command inventory with its existing ledger. This build-only metadata
does not change which commands the transport accepts.

`typecheck.contractNaming` records original source and annotation hashes.
`typecheck.declarations.files` and `sharedContractTypes` bind the shared `.d.ts`
tree. Contract provenance records compiler declaration production instead of
copied source-module suffix changes. The selection hashes still bind all 78
original capsule modules. Brands, Effect results and service tags retain their
original constructor types and share the same declaration files across entries.

The normal engine suite includes a default-host `tsc --build` consumer with
NodeNext, composite declarations, explicit `src` rootDir, full library checking
and negative brand/decoded/encoded fixtures. It audits the transitive build-info
file list: only the consumer is implementation source. Consumers reach 77
contract declarations; the emitted 78th file is the private `withRecordIdTable`
helper whose implementation import disappears during declaration emit.

The independently runnable original-contract gate uses the same compiler,
declaration writer, contract barrels and real package export map:

```powershell
pnpm.cmd exec turbo run test:t3-session-declarations --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

It checks the pinned capsule and selection, emits all original contracts into a
fresh owned candidate, then runs the same composite consumer. Test processes use
512 MiB and compiler children use at most 5120 MiB. Its `report.json` explicitly
records `fullEnginePackage: false`; this candidate does not qualify the prepared
engine, runtime, packed package or private worker.

On 8 November 2026, Windows Maxis used Node 24.19.0, pnpm 10.22.0 and TypeScript
5.9.3 with concurrency one. The focused Turbo gate passed both tasks in 47.37
seconds: 487 producer program files, all 78 contract declarations, five invariant
naming checks and a strict 469-file consumer with zero dependency implementation
files. Its declaration-tree SHA-256 is
`f43423e1d28393b6c543e783d913af474903a5460be45a11ee1a33666c1f0254`.

At the independent declaration checkpoint, the normal package build from parent
`f07536130f8e6581c0b43c406b54f90df0245e6c` stopped before compilation. Ordered
operation index 394, `codex-request-privacy-import` in
`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, fails with
`SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH`. Root subsequently regenerated
the composition and qualified the integrated producer through `b75e7d7` on the
same Maxis/Node 24.19.0 toolchain. Engine 13, client 20 and runtime 73 cases passed.
The ordinary composite consumer reached 470 files and 77 contract declarations,
with zero dependency implementations. Private worker/API builds and all 236
transitive declaration checks passed. No compiler heap or checking rule changed;
installed provider execution remains unqualified.

Both public dependency locks now include the already-declared
`remark-math@6.0.0` and its new dependency records. Existing resolved versions and
peer bindings are unchanged. Root integrated the same private importer and
missing package/snapshot records, preserved existing resolutions, and passed
the frozen offline metadata check.
