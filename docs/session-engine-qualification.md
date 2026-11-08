# Corrected combined session-engine qualification

V04 uses private base `44c27761ab63e34f12ca7eea019d781b78760278` and public
base `0dc9f269bb11830436f1196fe2195bddaf6ca0e1`. The isolated worktree is
`C:\Users\ondre\.t3\worktrees\Nessie\t3-9a397781`; public fixes belong to
`t3/v04-final-qualification`. Root owns the final public pin and integration.

## Source identity

- Original T3 commit `25bf84ab07f53f141c20239c63e383823a9d5ea0`, tree
  `b0ba4dad62fa11e0a1fd21f5d351d75926d7559e`.
- Capsule: 2,859 files, 52,121,600 bytes, SHA-256
  `6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`.
- Contracts commit `4dbabb20e42ce9b6c8381f64d3e80d43bde912aa`; input helper
  SHA-256 `bff917e9ce29b6023c3c756ee395672b17545d7d5825a5321a264790f6a37c5e`.
- Privacy commit `fdfdfed264be073a085a893ff3916fdd11c65f72`; manifest
  SHA-256 `85f076324103220a4dce9358684899de8f6cfa3eb4121fcf88a6dd8bfdf13a04`.
- Ordered state, client-connection, extraction and privacy families: 177
  operations, SHA-256
  `39ce53a11d6b526e1b154fa54fd2e0e50777c3c916b996bb178a26b15ba69a7a`.
  Extraction has 124 operations, SHA-256
  `d24f1709b6d7c1211d9987179d3fc727ef51e9c54d7c6900a1fceb8f900f1908`,
  and overlaps none of the five privacy files. Old-boundary/reapply attempts refuse.
- Producer dependency lock SHA-256
  `5929234e78b262af69280bf3ed1c21187665c3acccaab22ee53072f36ab9c97d`.

The producer, contracts, privacy and F02 gate follow-up commits all verified as
ancestors of the assigned public base. Source preparation reads only committed
objects from the coordinator's read-only reference repository. It reproduced the
capsule; no sibling dependencies, bundles or retained T3 state were consumed.

## Boundary corrections

The semantic checker enables library checks. The co-build executes the selected
hash-checked contract alias hook, then one producer resolver over the patched
snapshot and absolute dependency root. Ordinary consumers use both Bundler and
NodeNext without custom hosts, path aliases, runtime loaders or widened schemas.

The shared engine layer provides its retained state to the original output hub.
Internal event-sink/projection services must not leak into the host requirements.
The history probe builds shared state and passive reads over real SQLite; it
does not construct higher reactions, providers or effect/continuation consumers.
SQL, provider, settings and cleanup obligations remain required in the generated
types. CoBuildProof also checks original contract object identity, exact supplied
CRLF/Unicode/NUL secret strings, outer-ID/native-call correlation, replay and
getter refusal inside the emitted artifact.

CoBuildProof is a probe entry containing the actual higher engine and synthetic
qualification functions. It is not a distributable engine or lifecycle API.
Its provenance records this distinction. Engine.ts remains the library entry.

## Observed gates

Windows Maxis uses Node 24.19.0, pnpm 10.22.0, TypeScript 5.9.3, esbuild 0.25.12
and ESLint 10.2.0. Each heavy job is sequential with inherited
`NODE_OPTIONS=--max-old-space-size=1536` and a fresh minimum 12 GiB free-memory
guard. One plugin launch was refused at 10.36 GiB; it did no work until headroom
recovered. Producer dependencies used frozen, workspace/pnpmfile/script-disabled
installation with child/network concurrency one.

The actual public Turbo request aggregate ran its isolated frozen Effect 4.1.2
preparation, then 14 source checks and all 27 original-source fixtures: zero
failures/skips. Current producer bytes were verified against committed inputs;
the fresh combined digest is the one above. Logger/factory/publication fixtures
reproduce the rejected historical leaks and remove them under corrected source.

Both real plugin orders passed with the exact corrected committed input helper:
one Schema module and 306 Effect modules, actual namespace/codec object identity,
bundle SHA-256
`ddbdb025c1de1977621b093a179fec2d0e388ca2bf0e249af8bf0c83aabe3975`.
The selected dependency directory is this worktree's
`executor/packaging/session-engine`, with its own Effect 4.1.2 installation.

The initial corrected candidate passed semantic checks over 929 files, actual
import smoke, and both ordinary consumer modes over 378 type files. It exposed
the shared output-hub dependency defect during review; final qualification must
use the corrected shared composition rather than that initial candidate.

Final artifact, reproducibility, SQLite and packaged Node 22 outcomes are recorded
after their supported gates finish. No unrun gate is a pass. The full protocol
`test:t3-session-contracts` gate hardcodes a 5120 MiB compiler and remains outside
this auxiliary lane pending an explicit primary-resource handoff.

Native masked inputs remain refused until T13 supplies canonical Infisical
save/use/delivery. Authentication, preview, telemetry, provider credential stores
and driver implementations remain excluded by the source graph gate. Required
full lifecycle/provider/native/resource owners, gateway and actual mobile/client
journeys remain open. There was no native build/install, provider execution,
personal credential access, retained database access or browser/CI UI test.
