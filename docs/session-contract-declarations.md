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

The normal package build from approved public parent
`f07536130f8e6581c0b43c406b54f90df0245e6c` stops before compilation. Ordered
operation index 394, `codex-request-privacy-import` in
`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, fails with
`SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH`. The family owner must regenerate
that composition before full package, engine/client consumer and private
API/worker qualification. This tranche changes no request/privacy/workspace
manifests or private compiler configuration.

Both public dependency locks now include the already-declared
`remark-math@6.0.0` and its new dependency records. Existing resolved versions and
peer bindings are unchanged. The private lock still needs the same
`remark-math` importer entry for `executor/packages/t3-session-source`, plus any
new records absent from its current dependency closure; it is not edited here.
