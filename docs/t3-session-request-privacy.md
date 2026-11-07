# T3 request privacy source patches

Status: C05 source compatibility patches and synthetic source execution, 7 November
2026. This is a machine-only build input. It exposes no session UI or installed
capability. Canonical saving, scoped use and delivery still require the real
Nessie broker and installed admission; this tranche does not complete P17.

## Provenance and composition

The original T3 commit is `25bf84ab07f53f141c20239c63e383823a9d5ea0`, tree
`b0ba4dad62fa11e0a1fd21f5d351d75926d7559e`. C02's source preparation verifies
2,859 files, 52,121,600 archive bytes and SHA-256
`6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`.
The original MIT attribution remains in that capsule. Preparation reads committed
Git objects, including when the reference working tree is dirty.

`patches/t3-session/requests/boundary-patches.json` contains 26 ordered patches.
Its SHA-256 is
`82e946ecbf4a74a7d2dc809f25506ea6814498565e4e63c4e7e7ba4fb2120251`.
Every entry binds the source revision, unique seam and complete before/after
file hashes; sequential entries on the same file bind intermediate hashes.
`tool-privacy.ts` is the authored insertion fragment. It is inserted into the
existing upstream shared registry, keeping its existing package subpath and
avoiding another first-party runtime resolver or package export.

`index.mjs` exports `requestPrivacyManifestBytes`, `T3_REQUEST_PRIVACY_PATCHES`
(`sourceCommit`, `manifestSha256`) and `applyRequestPrivacyPatches(snapshot)`.
Application uses C02's existing `applySessionEngineBoundaryPatches`; no tar parser,
resolver, downloader or second source preparer is introduced.

The producer must concatenate C02 → unchanged T19 capsule manifest → committed
T02 extraction → C05, apply once, and record the SHA-256 of that **combined**
ordered manifest. A separately applied family's digest does not describe the
co-build. T19's separate web manifest is excluded from the engine capsule.

C05 was authored on public executor `d299129e499862fed79c8672dd53ed0b22df9055`
in `C:\Users\ondre\.t3\worktrees\Nessie\t3-c54598ec\executor`, branch
`t3/request-source-privacy`. The private checkout is at
`ab004ac6bba15a4f85fd9feabe53dc568632a337`, branch
`t3/t3-session-request-privacy`. No private pin is changed here.

T02's committed extraction family was not available in this checkout. C05 tests
compose C02 → T19 → C05 and prove those checked-in families apply together.
They do not claim the final four-family co-build. If T02 changes one of the five
files below, its owner must provide the committed preceding manifest/file hashes
before C05 can be regenerated against that intermediate source. Dirty sibling
source and ad hoc intermediate hashes are not inputs.

## Exact upstream inventory

Paths below are relative to the pinned upstream tree. Line counts include the
whole attributed dependency file; authored first-party code stays below 500
lines per file. No session screen, reducer, outbox, root manifest, lockfile,
producer, first-party shared export or native code changes.

| Upstream file | Original → patched lines | Patches | Purpose |
| --- | ---: | ---: | --- |
| `packages/shared/src/t3McpToolPresentation.ts` | 494 → 658 | 1 | Pure structural privacy projections next to the registered tool namespace aliases. |
| `packages/contracts/src/secretRequest.ts` | 69 → 71 | 2 | Preserve nonempty secret strings in the dedicated wire codec; remove unused trim-schema import. |
| `packages/client-runtime/src/secretRequest.ts` | 183 → 183 | 1 | Preserve the dedicated answer helper's value exactly. |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | 12,403 → 12,424 | 14 | Tool factory/publication, protocol logs, approval summaries/reasons, preview refusal and masked-question refusal. |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` | 8,059 → 8,068 | 8 | MCP/dynamic factory/publication, protocol logs, preview refusal and synchronous/asynchronous masked-question refusal. |

Complete initial/final hashes:

| File | Original SHA-256 | Final SHA-256 |
| --- | --- | --- |
| shared registry | `3215e846e75e9d095a858cc5b1dc70bbd097e82531ba8445f0ec387d0ed21eee` | `ff53108a049c819ecc39b932cc7840336ab176826e6b75aa9245ee4b0b8d6b73` |
| dedicated codec | `13117ebc9a34854bbf146aff24c748898ac2fec952525a769084e95c9b6392f9` | `8cc1a8a1b485dbdce28aa2e29a87bac63c1679e5f062634a03fc9660f273488b` |
| dedicated helper | `795884d84e57355ca838da10bb7217f0b75ed0d8bdd6a9035e44afc875aedda4` | `122ffc23a5f431633e4326d55776ad2e581698d2d812aba0a2f613a1d4b7b6f1` |
| Claude adapter | `7e212d616f62538bc0297973fd272ae20cf306abb46a56519f7959e2b7e1f86b` | `92bb27a526c8b1f7126d697a13a1bf7e92f9818a03621e32f04b916feea21695` |
| Codex adapter | `5913ec92bde020cbb23f5cbe3714b314fc9466406a22cc9721cf432418977c74` | `fa7a12d764d9cb6b46dfff59aaf034c81a72667317871f0d91b336e17d92bbcd` |

## Data flow and compatibility

`isSecretRequestTool` accepts exact registered namespace identities from the
pinned registry: `t3-code`, `t3_code`, `t3code`, `t3-code-direct` and
`t3_code_direct`, with `.request_secret` or `mcp__<server>__request_secret`.
It does not use the presentation resolver's loose regex/parser, infer meaning
from prose, or classify an arbitrary tool by a `secret` field. Bare and foreign
`request_secret` names remain ordinary tools. Admitted provider registrations
must preserve and reserve the actual qualified identities; a future provider
with a different registration needs an explicit audited identity mapping.

`projectSecretRequestInput` produces a separate public object. Valid ordinary
label/reason/placeholder/delivery/timeout/retry fields retain their semantics;
value and unknown malformed fields are redacted. String-encoded/malformed
arguments are fully redacted. `projectSecretRequestOutput` hides opaque tool
output, including returned errors and wrappers. `projectSecretRequestItem`
retains native IDs, provenance, ordinals and status, substitutes a fixed title,
and applies those projections. It runs in both factories and immediately before
adapter publication so a late MCP app-output override cannot restore a value.
Registered secret tools cannot capture MCP app previews into attachment files.

Claude approval prompts cannot select an SDK-supplied title, description or
decision reason containing the argument. The public approval reason is omitted
for this tool; existing rule/permission classification is retained. The SDK
callback and `permissionResultFromDecision.updatedInput` receive the **original**
argument. Redaction never substitutes fake bytes into canonical save/use.

Each original protocol logger owns a `createRequestPrivacyProjector()` closure.
It traverses decoded SDK/MCP records, nested batches and native MCP/dynamic tool
items before original bounding/summary serialization. Structural `tools/call`
wrappers require a qualified tool identity or explicit registered server.
Separate results/errors correlate by opaque call IDs, including replay and
results preceding calls in one batch. Only call IDs and explicit masked-question
IDs are retained; no secret value or fingerprint is cached. Traversal and
metadata limits fail closed to categorical metadata, including subsequent logs.
Other tool events are unaffected by an earlier secret call.

Explicit `isSecret: true` fields are redacted in structured native log records,
including keyed answer maps such as `__proto__`. Field/answer ordinals are not
renumbered. Native masked questions are refused with
`canonical_secret_question_port_required` before ordinary question persistence,
including Claude's early tool event and Codex's asynchronous conversion. The
request is not marked saved/resolved; its native callback/context retains the
source request identity. T13 must replace that refusal with a real canonical
masked-field operation before advertising support.

The dedicated wire still encodes `answer.secret` as a string. Its compatibility
patch changes validation to `length > 0` without trimming, matching the original
pasted-secret codec. Empty strings fail; whitespace-only strings, CRLF, newlines,
NUL and Unicode sequences are preserved. Ordinary IDs, labels, text and provider
reference syntax keep their original normalization. This promises exact supplied
string/UTF-8 value semantics, not an arbitrary binary wire format.

## Required canonical port and remaining admission boundaries

The privacy exports import no `SecretRequests` implementation,
`secret-provider-core/SecretResolver`, `ServerSecretStore` or vault adapter. The
shared registry executes as a complete dependency-free source module in the
fixtures. The original local-vault/cache implementation must remain excluded
from T02's compiled graph; its mere presence in the immutable archive is not
permission to import it. No `defaultServerSecretStore`, direct vault primitive,
local secret vault, process port or fake saved result is introduced.

T02 owns extracting the original `SecretRequests` Context tag/interface into its
session-port module. Its current methods are `answer(input)`,
`savedRef({threadId, turnItemId})`, `consume({ref, projectId})`,
`saveToFile({threadId, turnItemId})` and
`savePasted({threadId, requestNamespace, requestKey, value})`. C05 neither copies
that interface nor supplies an implementation. In particular,
`consume({ref, projectId})` alone is not an admitted canonical use contract.

The integrated broker must bind fresh owner/UOA team authority, computer,
session/request and field/answer ordinals, provider session, destination,
operation identity and generation. Canonical bytes belong only to existing
Infisical; `Secret`/`SecretGrant` remain metadata. The real port must authorize,
save idempotently, reconcile uncertain outcomes, and deliver/use through a
one-use scoped operation without importing the original lifetime resolver Map.
Cleanup erases transport references/files only. It must never equate consumption,
expiry or delivery failure with deleting the canonical saved vault record.

These projection changes cannot remove a value already present in user chat,
provider/model context, SDK-owned transcripts, native provider homes, inherited
history or external traces. Uncorrelated free-text SDK errors and arbitrary code
strings are not semantically inspected. Provider-native retention and error
boundaries need separate actual SDK/process evidence before confidential
cardless use can be admitted. The canonical port must return categorical errors,
never echo supplied bytes into original MCP service error messages. Historical
redaction (including the legacy short-value omission), drafts/outbox, backend
fingerprints/replacement retries, host-file `secret_saved` semantics and external
SDK secret storage are future T13 work. Source fixtures cannot establish global
session privacy or canonical save/delivery semantics.

## Focused execution and integration requests

The tests use C02's verified snapshot and resolver plus the committed T19
`sourceFunctions` and module-loader helpers from this checkout. They execute
the actual patched shared module, dedicated/pasted codecs with Effect 4.1.2,
client helper, both provider factories, native loggers with original bounds and
summary fallback, publication into real Effect queues, permission-result
callback, masked-question helpers and unchanged pasted MCP method. There is no
second sanitizer in the tests. The pasted-method fixture changes only its outer
object-property delimiter to execute that exact Effect body independently.

Provider presentation and unrelated web-search helpers use explicit synthetic
fixtures. The pasted MCP method receives a synthetic active-run/authority port
and a recording transport sink. This proves byte handoff and invalid-delivery
refusal, not UOA admission or a vault save. The tests do not launch a provider.

On Windows Maxis with Node 24.19.0 and pnpm 10.22.0, all **18 tests passed**, zero
skips, in about 1.2 seconds, with a 512 MiB heap. Before the final run Maxis had
15.63 GiB free and 5% CPU load. The isolated Effect-only install used the exact
integrity from C02's frozen lock, its own ignored dependency/store paths,
`--ignore-workspace --ignore-scripts --ignore-pnpmfile`, and child/network
concurrency 1. Jobs waited for at least 10 GiB headroom; no shared resource was
stopped or displaced.

Reproduce from the executor checkout, under a separately allocated tiny slot:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=512'
$env:T3_REQUEST_PRIVACY_SOURCE_REPOSITORY = '<read-only pinned Git reference>'
node test/t3-session-requests/prepare-dependencies.mjs
pnpm --dir .artifacts/c05-requests/dependencies install --ignore-workspace --frozen-lockfile --ignore-scripts --ignore-pnpmfile --child-concurrency=1 --network-concurrency=1 --store-dir .artifacts/c05-requests/store
node --experimental-vm-modules --test --experimental-test-isolation=none test/t3-session-requests/*.test.mjs
```

`T3_REQUEST_PRIVACY_SOURCE_ARCHIVE` can select an already prepared verified
capsule. `build-manifest.mjs <verified-source.tar>` reproduces the manifest; it
does not edit vendor source. The five complete patched files also pass Node's
TypeScript syntax stripping. Strict engine typecheck/lint/bundle, the combined
T02 co-build, Turbo task registration, Node 22, real vault/provider/UOA, browser,
mobile, native ACL/file cleanup and installed admission were not run here.

T01 must register separate pure-source and Effect codec/provider-fixture gates
through the existing public Turbo graph, preserving the isolated dependency
preparation prerequisite. No root/package/lock/Turbo/CI files are changed by
C05. T02 must compose the committed manifest and check the actual resulting
closure; T13 must implement the canonical save/use/delivery port and replace the
masked-question refusal only after its scoped proof passes.
