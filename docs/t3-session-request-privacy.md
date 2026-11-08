# T3 request privacy source patches

Status: P02 correction with masked-initial-answer follow-up, 8 November 2026. This machine-only build input is
consumed by the existing session-engine snapshot composer. Its supported entry
points are the source proof and synthetic provider fixtures below. It adds no
available session runtime or UI. Canonical saving and scoped delivery remain
unbound; this does not complete P17 or authorize confidential provider use.

## Provenance and composition

Original T3 commit `25bf84ab07f53f141c20239c63e383823a9d5ea0`, tree
`b0ba4dad62fa11e0a1fd21f5d351d75926d7559e`: 2,859 files, 52,121,600 archive
bytes, SHA-256 `6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`.
Preparation reads committed Git objects and preserves the MIT attribution.

`patches/t3-session/requests/boundary-patches.json` contains 26 ordered operations
on five upstream paths. Its corrected SHA-256 is
`98310d0219cab3a2183a9cb5ca9215823a42afb66bd9a0a830aed59f19b0a3c9`.
Each operation binds the revision, unique source seam and full before/after file
hashes. The authored `tool-privacy.ts` fragment enters the existing registered
shared module; it adds no resolver or runtime package export.

The public base is `f57a43dc9564b04ccd4d2a254c474773aaee875e`, with T02's
124-operation extraction manifest
`d24f1709b6d7c1211d9987179d3fc727ef51e9c54d7c6900a1fceb8f900f1908`.
The unchanged producer composes state → T19 capsule → extraction → corrected
request privacy, then applies that combined manifest exactly once to the verified
original capsule. The freshly computed result has **177 operations**, SHA-256
`8abd5bb0fd7818503b849a65a05440c1522fcdc1001b4fbd91f106e9cd65b6f1`.
The operation count happens to match a historical tuple; this digest was computed
from the current four families and does not reuse that historical acceptance.
T19's separate web manifest does not enter the engine capsule.

`verify-combined.mjs` checks the current composer and extraction bytes against
committed objects at that base, reproduces the privacy manifest from original
bytes, checks zero extraction overlap with all five privacy paths, and compares
their final bytes to independent privacy application. Reapplying privacy or
applying it to the rejected old boundary fails with `SOURCE_MISMATCH`.
This is source compatibility evidence, not a co-build or runtime claim.

| Upstream path | Final SHA-256 |
| --- | --- |
| `packages/shared/src/t3McpToolPresentation.ts` | `378e84e03da9fac1b0c308c8499761c243f1ace65c0cc7624f450e62568d360e` |
| `packages/contracts/src/secretRequest.ts` | `8cc1a8a1b485dbdce28aa2e29a87bac63c1679e5f062634a03fc9660f273488b` |
| `packages/client-runtime/src/secretRequest.ts` | `122ffc23a5f431633e4326d55776ad2e581698d2d812aba0a2f613a1d4b7b6f1` |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | `dbfc6774cc6759ede13fa1a83ea5cf33a9d4e6140da01d97c8698750e4136b9d` |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` | `fa7a12d764d9cb6b46dfff59aaf034c81a72667317871f0d91b336e17d92bbcd` |

Authored files remain below 500 lines. The attributed upstream adapters and
registry already exceed that cap; this patch does not copy them into first-party
source files. No producer, manifest registration, Prisma, native, root package,
lockfile, UI or original `SecretRequests` implementation is modified here.

## Rejected checkpoint and corrections

Public `db4bd5972777bcfae2df4f00f0292581bc17fb97`, manifest
`8f11f629fb93f3234f4e5ffff8bc49f1bdfa5f0ff773af9c65c16ba5fcf040d3`,
is historical rejected source. Its 18 passing tests missed these defects:

- A Codex `item/tool/call` hid its arguments but did not remember the outer
  protocol ID. A later `{id,result:{contentItems}}` or error could persist the
  value. P02 binds both outer IDs and native `params.callId`, preserving numeric
  versus string identity, request/error/replay correlation and mixed batches.
- MCP metadata was copied by allowlisted field name. A nested object under
  `params.status` could carry a value. Each admitted metadata field now checks
  its scalar type. The supported `nativeItemRef` object projects only its known
  string members; unknown or malformed metadata is redacted.
- Primitive members escaped the traversal budget, and traversal continued after
  exhaustion. Capture now charges every value and property key, bounds UTF-8
  bytes and depth, and stops immediately. It reads data descriptors rather than
  invoking getters and avoids an upfront `Object.values`/`Object.entries` copy
  of untrusted objects. Sparse or oversized arrays are refused at their length.

One logger invocation allows 32,768 visited values, 1 MiB of string/key UTF-8
bytes and depth 64. The logger retains at most 8,192 combined call/question IDs,
256 KiB of encoded correlation keys and 1,024 bytes per typed ID. Duplicate IDs
consume no additional correlation budget. Exhaustion, cycles, accessor fields
or unsupported object shapes yield categorical `request_projection_unavailable`
metadata, including later calls on that logger. No value or fingerprint is cached.
The boundary expects decoded protocol data, not arbitrary executable Proxy
objects; JavaScript Proxy traps themselves cannot be made side-effect free.

## Preserved semantics

Only exact registered `request_secret` identities are sensitive: `t3-code`,
`t3_code`, `t3code`, `t3-code-direct`, `t3_code_direct`, qualified with a dot or
`mcp__<server>__request_secret`. Bare and foreign names remain ordinary tools.
There is no prose interpretation, keyword detection or secret-substring search.

Sensitive projections run before actual native protocol logging/bounds/summary,
both tool factories and final Effect publication, approval summaries and preview
capture. Valid IDs, status and ordinals remain available. Late app-output
wrappers cannot restore the value. The authorized operation and original native
callback retain the exact unmodified input; redaction never substitutes fake
bytes into a save or use operation.

Dedicated helper and real Effect codecs reject only empty secret strings. They
preserve whitespace-only strings, CRLF, newlines, Unicode sequences and NUL.
This is exact supplied string/UTF-8 semantics, not an arbitrary binary wire.
Ordinary labels, IDs and provider-reference normalization remain as upstream.

Native `isSecret` questions remain refused before ordinary persistence with
`canonical_secret_question_port_required`, including Codex asynchronous forms.
T13 must supply a canonical field/ordinal port before reopening that path.
Question IDs such as `__proto__` and original ordinals survive public projection.
The original question schema's `initialAnswer` is also sensitive when an explicit
`isSecret` marker is present. The follow-up adds that exact structural field to
the existing projection; ordinary unmasked initial answers remain ordinary data.
This does not recover mask markers removed before a caller invokes the projector.
The retained-capture caller still needs its separate classification-order repair.

## Remaining admission boundaries

The insertion imports no local secret store, lifetime resolver, vault adapter
or `SecretRequests` implementation. T02's existing session-port interface remains
unchanged. No fake saved result, cache, file-delivery service or canonical save
stub is introduced. Original local-vault/cache source must stay outside the
compiled engine graph.

T13 must bind fresh UOA owner/team authority, computer/session/request/provider
identity, original field/answer ordinals, destination, operation and generation.
Every supplied secret first saves idempotently through existing canonical
Infisical storage with metadata-only `Secret`/`SecretGrant` records. It must
reconcile uncertain outcomes before scoped one-use delivery. Storage and provider
delivery are separate facts. Cleanup erases transport material and must never
delete the saved canonical vault record.

These projections do not erase SDK/vendor/native transcripts, a prior user paste,
provider/model context, inherited history or external traces. Uncorrelated prose
errors and arbitrary code strings are not semantically inspected. Historical
short-secret redaction, backend storage/delivery, draft/outbox privacy, Windows
ACLs, native custody and installed admission need their own proofs. Source tests
and a synthetic recording transport sink establish none of those boundaries.

## Focused verification

On Windows Maxis, Node 24.19.0 / pnpm 10.22.0, the corrected source and fixtures
passed **27 tests, zero skips**, under a 512 MiB heap. The standalone current
composition proof also passed. The fixture dependency root is owned by this
worktree and contains only frozen Effect 4.1.2, installed without scripts,
workspace hooks or copied outputs, after checking at least 10 GiB free RAM.

The masked-initial-answer follow-up reran the registered Turbo source and fixture
tasks sequentially on Maxis: **14 source checks and 27 fixture checks passed,
zero skips**, including the strengthened masked-question regression. The exact
fixture preparation and frozen script-disabled single-Effect install ran first;
Turbo used `--only` to avoid repeating that preparation. Fresh host headroom was
checked against 12 GiB and each Node heap was capped at 512 MiB. The new manifest
and combined digests above supersede the earlier `85f076`/`39ce53` source tuple.
The normal generated package, portable type consumers and Node 22 co-build have
not been requalified with this changed helper; their earlier hashes remain
historical evidence, not acceptance of these bytes.

The fixtures execute the actual shared helper, real dedicated/pasted codecs,
original answer helper, provider factories, native callback, protocol loggers
with original persistence filter/bounds/Codex redactor and real Effect queue
publication. Both loggers execute historical rejected source as well: outer-ID
result and nested-status canaries leak there and disappear after correction.
Budget tests exercise 40,000 primitive members, sparse arrays, huge objects,
per-ID and aggregate UTF-8 bytes, shared correlation count, equivalent batches,
accessors and immediate array refusal. Original secret bytes remain unchanged.

The pasted-method fixture runs its original Effect body with a synthetic
recording transport port. It proves handoff bytes and invalid-delivery refusal;
it does not represent a vault save or provider acceptance.

From the executor checkout, the registered focused source and fixture Turbo
gates must preserve these commands and their dependency preparation prerequisite:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=512'
$env:TZ = 'UTC'
$env:T3_REQUEST_PRIVACY_SOURCE_REPOSITORY = '<read-only committed reference>'
node test/t3-session-requests/prepare-dependencies.mjs
pnpm --dir .artifacts/c05-requests/dependencies install --ignore-workspace --frozen-lockfile --ignore-scripts --ignore-pnpmfile --child-concurrency=1 --network-concurrency=1 --store-dir .artifacts/c05-requests/store
node test/t3-session-requests/verify-combined.mjs
node --experimental-vm-modules --test --experimental-test-isolation=none test/t3-session-requests/*.test.mjs
```

`T3_REQUEST_PRIVACY_SOURCE_ARCHIVE` can select an already verified capsule.
F02 owns registration. Final co-build qualification still requires its corrected
committed contract alias/mapping tuple, the committed corrected privacy/hash,
current producer, one resolver/dependency root/Effect 4.1.2, ordinary strict
exported consumer, actual import smoke and same-artifact SQLite history/replay.
No co-build, packaged Node 22, real provider/vault/UOA, browser, native/device
or installed runtime claim is made by this source checkpoint.
