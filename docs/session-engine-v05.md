# Independent combined-engine qualification

V05 owns `C:/Users/ondre/.t3/worktrees/Nessie/t3-0c55e276`, private branch
`t3/0c55e276`. Its clean private base is
`23debbc24772c4922299c154a69b7c39f391ab58`; the indexed public executor pin is
`2bc2a8411c68908586c6df5d3352fb82506a6d60`. The owned public branch is
`t3/v05-independent-qualification` inside that worktree's standard `executor/`
submodule. V05 does not advance the private gitlink.

The coordinator reviewed the expected divergence at
`0dc9f269bb11830436f1196fe2195bddaf6ca0e1` and authorized integration of exact V04
`f4f865588cd0400e77b4caa16e926e6e121245c8`. Merge
`b968296526666ad8a3242b28a95bf6f032acd200` retains both histories. The base-side
source-cache assertion wrap is unchanged; the merge adds only V04's 13 scoped
source/documentation files. The merge was pushed immediately.

## Fresh inputs and artifact

Windows Maxis ran Node 24.19.0, pnpm 10.22.0, TypeScript 5.9.3, esbuild 0.25.12
and ESLint 10.2.0. V05 used only AUXILIARY, one job at a time, with inherited
`NODE_OPTIONS=--max-old-space-size=1536` and a fresh 12 GiB free-memory launch
guard. Resource records and logs are retained under the owned ignored
`packaging/session-engine/.artifacts/v05/` directory.

`prepare-dependencies.mjs` read committed objects from the authorized read-only
reference repository. It created a fresh 2,859-file, 52,121,600-byte capsule with
SHA-256 `6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`
and materialized the three hash-verified dependency patches. No sibling
dependencies, interpreter, bundle, receipt or test output was copied or imported.

The scoped producer install used a fresh owned store with frozen lockfile,
`--ignore-workspace --ignore-scripts --ignore-pnpmfile --child-concurrency=1
--network-concurrency=1`. It installed 206 packages, reporting zero reused
packages. The lock hash is
`5929234e78b262af69280bf3ed1c21187665c3acccaab22ee53072f36ab9c97d`.

The final selected source tuple is unchanged from V04:

- T3 commit `25bf84ab07f53f141c20239c63e383823a9d5ea0`, tree
  `b0ba4dad62fa11e0a1fd21f5d351d75926d7559e`.
- Contracts `4dbabb20e42ce9b6c8381f64d3e80d43bde912aa`, committed hook SHA-256
  `bff917e9ce29b6023c3c756ee395672b17545d7d5825a5321a264790f6a37c5e`.
- Privacy `fdfdfed264be073a085a893ff3916fdd11c65f72`, manifest SHA-256
  `85f076324103220a4dce9358684899de8f6cfa3eb4121fcf88a6dd8bfdf13a04`.
- Extraction: 124 operations,
  `d24f1709b6d7c1211d9987179d3fc727ef51e9c54d7c6900a1fceb8f900f1908`.
- Ordered state/client/extraction/privacy: 177 operations,
  `39ce53a11d6b526e1b154fa54fd2e0e50777c3c916b996bb178a26b15ba69a7a`.

Fresh `run-a/combined.mjs` passed strict semantic and library checks over 929
files. Its 4,606,909 runtime bytes have SHA-256
`20ab998d8b6f0061f34df3e52367c9161bc700827b0a5c4c4aa5bb886cb84c91`.
The 378-file portable type closure is
`3df975850bb39c1cde6acb0bfd7484707018bae37b80d575e5cd9d27a70cd9b4`.
This is **CoBuildProof, synthetic and non-distributable**. It is not a packaged
runtime or a lifecycle API.

The owned integrity verifier independently rehashed every current authored and
producer input against both provenance and committed Git bytes; every original
and patched source input against the verified capsule; every dependency input
under this owned dependency root; and every declaration/type-source file.
There are 347 runtime source modules, 635 dependency modules, one Effect 4.1.2
graph with 311 Effect modules and one Schema module. All 97 dependency notices
and the original complete MIT license remain present. Provenance and license
hashes match V04 exactly:

- Provenance: `10a9beb3bdc5681b1d506efbefdef045b3659978763ba0c3d3e4919b102874f6`.
- Notices: `b3bfb9fbb65ef16a9a654571025c2b9b7ebc0da6174e68d248574b9d3fe4eefa`.

## Official Node 22 execution

V05 downloaded its own exact
[Node 22.23.1 Windows x64 ZIP](https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip)
and [official checksums](https://nodejs.org/dist/v22.23.1/SHASUMS256.txt).
The ZIP SHA-256 is
`7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29`;
the extracted EXE SHA-256 is
`f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed`.
Authenticode is Valid with subject `CN=OpenJS Foundation, O=OpenJS Foundation,
L=San Francisco, S=California, C=US` and a Microsoft timestamp certificate.
This portable interpreter lives only in the owned ignored artifacts directory.

The actual `smoke.mjs` entry passed on Node 22.23.1 against `run-a/combined.mjs`:
no process creation during import/factory construction, retained state-layer
references, original protocol/schema identity, and artifact privacy assertions
for exact CRLF/Unicode/NUL values, correlation, replay and getter refusal.

The same artifact then passed the actual file-backed `history-proof.mjs` entry
on Node 22.23.1, with all 80 original migrations. Results: 162 catalog threads,
10 archived, 60 older settled, 360 history rows over nine pages, 360 inherited
rows, three family members and one Markdown match. Replay and high-water/live
handoff each produced one event with zero duplicates. Future and pruned cursors
each produced an authoritative snapshot; reopening retained all 360 rows.
Repeat hydration imported zero messages and the dormant outbox effect remained
unchanged. No provider service or effect consumer started.

The runtime observed boolean `isTransaction` and absent `setAuthorizer`, matching
the [exact-version SQLite API](https://nodejs.org/download/release/v22.23.1/docs/api/sqlite.html).
On initial open and reopen, the original adapter logged that the checkpoint
worker was unavailable and checkpoints ran on the main connection, because
transaction-state or statement-authorizer support was missing. No compatibility
shim, source change or custody relaxation was needed. This is a synthetic
portable Node 22 runtime pass; the fixture's `packagedNode22Qualified:false`
remains accurate because no installed payload was exercised.

## Pending gates and consumer ownership

Independent second-output reproduction, current request fixtures, ordinary
Bundler/NodeNext consumers and both plugin orders are pending in this checkpoint.
The full `test:t3-session-contracts` gate hardcodes 5120 MiB and remains queued
until the coordinator explicitly transfers PRIMARY. A refused launch is not a
failed test or a passing gate: Node 22 history initially refused at 11.75 GiB,
then passed at 12.63 GiB; consumer launch refused at 11.93 GiB.
The next consumer attempt refused at 10.11 GiB with 82% CPU load. No job was
launched by either refused attempt. The coordinator requested a checkpoint
handback while the existing PRIMARY owner finishes; AUXILIARY is released/idle
at this checkpoint. No PRIMARY handoff has been received.

The following commands remain **unrun**. Run each bounded command separately,
only after a fresh resource guard passes. The distinct `run-b` output does not
exist yet; it must be produced by a new invocation, not copied from `run-a`.
The ignored verifier already checks actual input/type/license bytes and is ready
to compare the two independent outputs and ordered provenance inputs. Identical
tools and owned dependency paths should require no provenance-only differences.

```powershell
# From this owned public executor checkout. No root dependency install.
$env:NODE_OPTIONS = '--max-old-space-size=1536'
$source = 'C:/Users/ondre/.t3/worktrees/Nessie/t3-7a4698a9/.artifacts/t3-reference'
$probeA = 'packaging/session-engine/.artifacts/v05/run-a/combined.mjs'
$probeB = 'packaging/session-engine/.artifacts/v05/run-b/combined.mjs'
$capsule = 'packaging/session-engine/.artifacts/source-6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096.tar'
$contracts = '4dbabb20e42ce9b6c8381f64d3e80d43bde912aa'
$privacy = 'fdfdfed264be073a085a893ff3916fdd11c65f72'
$privacyHash = '85f076324103220a4dce9358684899de8f6cfa3eb4121fcf88a6dd8bfdf13a04'
$inputHash = 'bff917e9ce29b6023c3c756ee395672b17545d7d5825a5321a264790f6a37c5e'
node packaging/session-engine/consumer.mjs $probeA
node packaging/session-engine/co-build.mjs $source $probeB $contracts $privacy $privacyHash
node packaging/session-engine/.artifacts/v05/verify-artifacts.mjs $probeA $probeB
$env:T3_REQUEST_PRIVACY_SOURCE_REPOSITORY = $source
$env:T3_REQUEST_PRIVACY_SOURCE_ARCHIVE = (Resolve-Path $capsule).Path
pnpm.cmd --store-dir .artifacts/v05-dlx-store dlx turbo@2.11.10 run test:t3-session-requests --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm.cmd --store-dir .artifacts/v05-dlx-store dlx turbo@2.11.10 run test:t3-session-engine-plugins --root-turbo-json=scripts/turbo.public.json --concurrency=1 -- $capsule $contracts $inputHash
```

The request fixture's owned ignored dependency directory already contains an
`.npmrc` selecting this worktree's `.artifacts/v05-request-store`; its actual
frozen/script-disabled install and current 14/27 fixture rerun have not run.
The logger `params.callId` and native-callback NUL assertions are present in
current committed source and remain unqualified by a fresh fixture execution.

After explicit PRIMARY transfer, the registered gate is
`pnpm.cmd dlx turbo@2.11.10 run test:t3-session-contracts
--filter=@nessie/executor-protocol --root-turbo-json=scripts/turbo.public.json
--concurrency=1`. Its normal package prerequisites must be prepared in this
owned tree with frozen, script-disabled scoped installs and an owned store.
They have not been installed here. Do not reduce the committed 5120 MiB compiler
allowance to fit AUXILIARY or treat a sibling run as this gate's result.

The next package owner must expose normal generated runtime and portable types
with a declared Turbo producer prerequisite. The APIs remain
`createSessionStateLayers()`/`SessionStateServices` and
`createSessionReadLayers(state?)`; the combined read layer requires the real
`SqlClient.SqlClient`. `getThreadTranscript` additionally requires
`EnvironmentIdentity.ServerEnvironmentIdentity`, and shell streaming needs
project enrichment. Current authored input admission remains `core/**` and
`packages/t3-session-source/src/**`. T04 must wait for that package owner and
must not import this worktree's artifact paths.

No final gitlink advancement is justified yet. Sensitive SDK/native history
erasure, canonical vault save/use/delivery, provider/resource/lifecycle/installed
admission and mobile/client acceptance remain unqualified. V05 ran no native
build, installation, release, retained session mutation, credential operation,
service change or browser flow.
