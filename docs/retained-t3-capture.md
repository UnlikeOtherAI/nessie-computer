# Retained T3 capture

The source-only [catalog read composition](retained-t3-catalog.md) extends these
guarded wrappers with original shell/archive/family/history operations. Physical,
human, publication and actual transport bindings remain required; it grants no
new authority and changes no historical privacy classification.

This is a machine-only, unbound passive importer. It adds no daemon capability,
bridge adoption, provider, lifecycle, transport, native payload or UI. It does not
make retained sessions reachable in Nessie. Local data completion does not mean
server catalog completion, current read entitlement or execution custody.

## Required producers

`AdmittedT3SourcePort.withReadonlySource` consumes an explicit manifest of
admission references for desktop userdata, desktop development, server and
configured homes. The existing local-resource authority must enumerate those
admitted homes; T04 never crawls directories or guesses homes from a login.
Its callback receives a physical source identity, original environment ID,
verified storage role/layout, an actually readonly SQLite connection and the
producer's live physical recheck function. That producer must hold OS root,
database/WAL, symlink-alias, replacement and persisted environment identity
evidence for the whole callback. Configured v2 is authoritative; adjacent legacy
files are never merged. Path normalization and caller IDs are not proof.

`RetainedOriginalOwnerPort.withReadScope` is a separate canonical authority
dependency. It receives the same live physical recheck function, source,
capture generation and `retained-history-read` purpose. The real producer must
recognize that function's in-process resource binding, bind the current human
context, executor, physical root, environment, original thread, original owner
generation and capture generation, and expose callback-scoped `recheckSource`
and `recheckThread` functions. Neither JSON references/expiry metadata nor
arbitrary caller functions can construct that binding. Rechecks must enforce
current revocation and read freshness at most 60 seconds; the lease expires at
callback exit. T04 creates no global owner cache or receipt authority.

Both producers are REQUIRED and unbound. Missing producers deny before capture
or history reads. T03C's immutable accepted managed-start ownership is not
original-owner continuity for native, external or legacy retained sessions.
Today's login, computer administration, assignment, ownerKey, namespace,
generation or inventory cannot adopt them. A1 read admission never grants A0
control or custody renewal. The final wire/ref contract awaits the committed
canonical producer; these local interfaces are not a competing wire schema.
T03C's read-only source checkpoint
`f5462b8ac8f3c2c359ac1f3bfcc2d7cc608e32d2` names
`ExecutorManagedSessionEvidenceSchema`, `ExecutorCodingSessionAuthoritySchema`
and `ExecutorSessionPairingSourceSchema` in the protocol package. Their target,
managed-start and pairing metadata are pending producer interfaces, not retained
continuity evidence. They are not integrated or consumed by this checkpoint.

`OwnedCaptureWorkspacePort` must allocate/reopen isolated executor-owned SQLite
generations through the original `Sqlite` layer, outside checkouts with the
existing platform ownership/lock protections. It must never return a source
SQL layer. Production durable-path/lock/native custody binding is not supplied.
`NativeHistoryHomePort` must prove continuation and history homes independently.
Without it native references remain in the original projection but alias proof
is unavailable. T07's catalog claim/publication port also remains unbound.

## Data path and recovery

`withT3SourceSnapshot` runs supported `BEGIN`/`COMMIT` read transactions, including
WAL-visible rows. It reads only fixed named tables/columns and migration/schema
metadata. Supported layouts are the exact original migration manifests through
54 (sole legacy) or 80 (v2); missing/divergent/unsupported layouts fail. It never
runs source migrations, checkpoints or write pragmas, uses `immutable=1`, copies
raw databases/archives, or reads provider credentials, auth/device/account rows,
ServerSecretStore, native transcripts or arbitrary attachment files.

`materializeSnapshot` classifies raw stored records before codec normalization.
The first preflight retains only bounded thread/request/question IDs and explicit
boolean `isSecret` classification. Absent markers may resolve from another exact
occurrence of the same request/question in this pinned source transaction; they
never inherit classification from another request or thread. Missing classification uses the explicitly withheld representation in
[historical question privacy](historical-question-privacy.md). Malformed or
conflicting classification and missing request provenance still fail capture. Wording is never used.
The second preflight projects and validates every row before any session INSERT;
the final pass repeats that projection over the same read transaction.
It uses the same patched original `RequestPrivacy` namespace:
`isSecretRequestTool`, `projectSecretRequestInput/Output/Item` and
`createRequestPrivacyProjector`. Correlation persists per original thread over
all complete passes, including responses before requests, replay and exact
dynamic-tool native call IDs. It never resets per page/row or projects a whole
large transcript as one capped value. Exhaustion, oversized records or invalid
post-projection original schemas leave the generation incomplete. This bounded
correlation retains opaque IDs, not a second cache of secret values.

Masked question defaults, option values/previews, runtime answers and embedded
`questionAnswer` values are projected before the original codecs strip native
mask flags. Answer values retain their original shape when public. Masked and unknown-classification attachments retain inert IDs, types, sizes
and ordering with names/MIME/source metadata withheld; no delivery is inferred. Each capture uses fresh classification;
reusing a preflight object is refused. Resume reads only the already projected
generation, and refresh reclassifies source data. Unknown classification is explicitly withheld, never permission to omit a
session or claim full-fidelity parity. This correction passed the synthetic original-engine gate described below.

Original codecs validate stored entities/events and strip unsupported fields.
Typed runtime-request references become `not_resumable`, with no native callback
affinity. Attachment descriptors remain inert; no bytes are opened. Schedules,
webhook journals, executable outboxes, launch/recovery work and provider hosts
are excluded. Ordinary historical prose remains ordinary prose. Uncorrelated
historical plaintext in messages or prior native/SDK storage cannot be detected
or erased structurally; this is not a claim to sanitize those stores.

The destination uses one `createSessionStateLayers` reference with
`createSessionReadLayers` and the real `LegacyV1ThreadImporter`. There is no
replacement DTO, reducer, history engine or resolver. Catalog enumeration reads
all original projection rows, including archived/deleted, old/settled, empty and
orphan threads, without scanner, tag, workspace, provider or shell limits. Local
lineage, delegatedFrom and remoteChild remain independent original data.
`readRetainedProjection`, `readRetainedSnapshotWindow` and
`readRetainedHistoryPage` use original services under fresh callback admission.
T07/T09 still own entitled transport projection and publication.

All three read wrappers mean the latest **locally published capture**, not the
live source at call time. At entry and immediately before returning they require
the requested generation to be ready, available, nonconflicting and equal to the
root's current, catalog and hydrated generations. An in-progress or failed
refresh makes prior captures unavailable through these wrappers. Advancement or
revocation during an await rejects the result. There is no historical-generation
read API and no fallback to `last_ready_generation`.
Capture and resume receipts also recheck publication after the final physical
and owner lease awaits, so an advanced generation cannot return a ready receipt.

Successful capture/resume returns the admitted source descriptor and the original
source watermark `{ generation, sequence }` alongside local readiness. The
sequence is the journal's captured source high-water, not a destination sequence
created by legacy hydration. Physical root, environment and capture generation
must accompany every parity observation. The producer must still prove its
actual source revision and installation coverage; a supported layout is not
revision evidence and this return value grants no authority.

`sourceSnapshot` also returns a versioned keyed digest of the admitted ordered
rows in the pinned transaction. The owned journal stores the digest, layout and
a random journal-local HMAC key; it stores no raw row values. The fingerprint
covers all admitted columns, including non-event tables. Resume requires an
exact match with a fresh pinned snapshot, in addition to source identity and
event high-water. Legacy sequence zero alone proves nothing about contents.
This is snapshot equality, not an authority token or a claim that the live
source cannot advance after the read transaction. Old journal generations with
no fingerprint cannot resume or establish a versioned refresh baseline.

For `v2-80`, the original client's legacy tables are a frozen copy. The first
materialized snapshot establishes a journal baseline for the complete fixed
legacy thread/message/pull-request tables, including currently ineligible rows.
Every later capture requires that baseline unchanged, even after a failed
refresh. Additions (including chronological appends), edits and deletions refuse
with `capture_frozen_legacy_diverged`; no row is omitted or renumbered. The first
baseline cannot prove earlier source provenance or exclude prior external
mutation. The physical producer must still prove original frozen-copy semantics;
that admission remains unbound. V2 event/projection changes are recaptured into
a new destination and do not require legacy changes.

For `legacy-54`, each fresh capture has no copied V2 positions. The original
importer orders all messages by `(created_at, message_id)`, including backdated
and equal-timestamp insertions. Changed legacy contents require fresh capture,
never resume of the prior stage. No timestamp rewriting, arbitrary ordinal
assignment or omission is used. These are separate source-layout contracts.

Historical original question codecs may erase `isSecret` everywhere in a
snapshot. The source correction now preserves these sessions with explicit
unknown-classification redactions; see [its evidence and limits](historical-question-privacy.md).
Its original-engine gate now passes both marker-bearing and actual codec-erased
question cases. ALL-session live acceptance still requires the unbound physical
and original-human producers and complete real-machine coverage.

Each refresh allocates a new staging generation and resets destination legacy
completion markers. Fresh original read/import services invalidate process
caches. Interrupted hydration resumes the same staged data through original
event IDs; an unfinished source transaction requires fresh capture. The local
journal serializes capture advancement/completion and rechecks the current
generation inside its write transaction. Proven physical aliases converge;
distinct roots with one environment create a sticky conflict retaining both
candidates. Unavailable/incomplete work retains prior identities and tombstones;
absence never resurrects or deletes one. Native alias candidate sets preserve
every app history, separate homes and weak references, without electing a writer.

## Gates and evidence

Historical-question code/test revision `e6807fca397168348b630dea27b0e2d60b81dbf7`
passed normal build/typecheck, 15 source cases and all 32 original-engine importer
cases on Maxis/Node 22.23.1, zero failures/skips. This supersedes missing-mask
refusal and masked-attachment refusal for the documented safe representation.
See [the exact value/descriptor contract](historical-question-privacy.md).
Original physical/human authority and live all-machine parity remain unclaimed.

The currentness correction passed ordinary executor build/typecheck and the
registered importer gate on Maxis with owned Node 22.23.1: **27 passed, zero
failed/skipped**. This includes all three real read wrappers under obsolete,
unavailable, in-progress/failed refresh and advancement/revocation races;
capture/resume receipt races; unchanged-sequence snapshot mutation; V2 frozen
legacy insert/edit/delete refusal; and fresh legacy-54 backdated, equal-time and
append ordering with exact original timestamp/ordinal comparisons. Source code
is unchanged from the built checkpoint; subsequent fixes corrected only fixture
DateTime formatting and the original snapshot budget used before cursor bounding.
The earlier 21/27 and 24/27 attempts are retained, not counted as passes.
Engine exports, codec/Context identity and generated dependency bytes did not
change. The private currentness receipt records exact sources, output hashes,
commands and logs. PRIMARY and the coordinated heavy window were released
immediately after the passing gate. Live and ALL-session blockers above remain.

The source gate needs no dependency installation. It uses Node builtins, builtin
type erasure and disposable synthetic SQLite files in this worktree's ignored
artifacts. Set `T3_SESSION_IMPORT_REFERENCE` to the explicitly admitted readonly
Git object store, then run from the public root:

```powershell
pnpm exec turbo run test:t3-session-import-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

This registered task has no build prerequisite and includes bounded question
classification tests. Its SQLite schema is synthetic: this is source/readonly/journal
evidence, not original-engine materialization or production authority proof.

The later PRIMARY/aux request is an owned frozen public preparation with pinned
pnpm 10.22.0, then the normal engine and executor dependency builds/typechecks,
followed by `test:t3-session-import`, concurrency one. Compilers retain the
normal maximum 5120 MiB allowance; tests use 512 MiB. Do not launch these in the
tiny lane. Example after explicit lane handoff and dependency preparation:

```powershell
pnpm exec turbo run build typecheck --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm exec turbo run test:t3-session-engine --filter=@nessie/t3-session-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm exec turbo run test:t3-session-import --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

Export `DATABASE_URL` for package gates as required by the repository standard;
these focused importer gates themselves use disposable SQLite, not PostgreSQL.
Prepare only this worktree's dependencies. Run the compiler steps with the normal
5120 MiB ceiling, then lower `NODE_OPTIONS` to `--max-old-space-size=512` for tests.
Repeat the updated normal package/strict consumer and importer gates on the owned
Node 22 interpreter. No prior package qualification covers these changed bytes.

The authored engine gate uses the normal built package, original migrations,
actual original legacy importer and real disposable SQL. It covers >5000 old
catalog rows, opaque Unicode IDs, archives/tombstones, >200 history rows/paging,
source refresh after completed hydration, interrupted importer recovery,
cross-record secret canaries and exhaustion, inert callbacks, independent family
edges/orphans and retained native overlay/tombstone aliases. The initial source
checkpoint left these unrun; the independent qualification below supersedes that
status. `privacy-destination.test.mjs` uses original package
state/read/importer interfaces and the supported readonly capture port. It
asserts masked defaults/options/answers are absent from all destination SQLite
exports and main/WAL/journal files, original event replay, repeated cached reads,
bounded wire exports, diagnostics, resume and refreshed legacy history. It also
asserts missing/unknown/conflicting masks, orphan answers and capacity exhaustion
retain the prior catalog instead of reporting success. These tests now pass on
Node 22, including masked-attachment refusal before insertion. Full attachment
delivery and the real producers remain unbound.
The new privacy namespace export changes runtime/types/provenance;
the prior 5013e582 normal-package qualification is historical input evidence.

The privacy registration now binds reviewed commit `7567a431d3404a0c3a2610c23bebbc4e8eb6ff5f`,
manifest `98310d0219cab3a2183a9cb5ca9215823a42afb66bd9a0a830aed59f19b0a3c9`
and composed manifest `8abd5bb0fd7818503b849a65a05440c1522fcdc1001b4fbd91f106e9cd65b6f1`.
Importer files remain ordinary executor consumers, outside the generated engine
graph; only the already registered `core/Engine.ts` gains the privacy namespace.
No authored-input wildcard or unrelated lock resolution is added.

The initial source checkpoint ran no compiler, install or runtime gate. Private
lock integration belongs to root: preserve private
pins and use pinned 10.22 frozen metadata validation plus full dependency-reference
and integrity checks. Public lock edits change only this consumer importer; no
package/snapshot resolution records are repinned. T07's actual PostgreSQL
root/source race awaits its bound port and an explicit T03C-free lane. Installed,
real-user, provider, gateway/client and end-to-end evidence are all unclaimed.

The independent Node 22 qualification found that the normal engine gate's strict
consumer compiler inherited the 512 MiB test heap and exhausted it. The compiler
child now explicitly uses the standard 5120 MiB cap; the test process stays at
512 MiB. This changes no compiler checks or consumer assertions.


Independent qualification now runs the normal importer gate against generated
engine declarations. Replay assertions use the original stored-event envelope
(`row.event.id`), and the append-refresh fixture supplies a timestamp after
existing history. The prior backdated fixture and failed gate logs are retained.
A valid masked attachment exercises refusal in the projected preflight, with
explicit zero-row assertions across destination session tables. These synthetic
fixtures do not bind either production authority producer.

## Independent Maxis qualification — 8 November 2026

Code checkpoint `c1f4556b251af2d88cd3ef6b179a830257486c7d` was exercised in
`C:/Users/ondre/.t3/worktrees/Nessie/t3-27e962ac/executor`, branch
`t3/t04-retained-session-qualification`. The parent gitlink remains `5688c25`.
All runtime gates used independently downloaded, checksum- and signature-verified
Node 22.23.1, pnpm 10.22.0 and TypeScript 5.9.3, sequentially on Maxis. No native,
provider, personal-history, server, PostgreSQL or production-authority work ran.

- Normal engine and executor build/typecheck passed without relaxing the executor's
  ES2022, Node 20 typings or unused-symbol settings. The generated engine closure
  now consists of real compiler declarations; shared contract source types retain
  their documented representation. Strict consumers keep library checks enabled.
- The registered source gate passed 11 cases; importer gate passed 12; engine
  gate passed six. Request privacy passed 14 source and 27 overlapping fixture
  cases. Every listed gate reported zero skips. Scoped first-party lint passed.
- The importer compared all 5,007 original catalog identities/states and complete
  thread/message/turn-item records in source order, plus 360-message history,
  pagination, interruption/resume, appended legacy refresh, lineage and aliases.
  Masked defaults/options/answers were absent from SQLite main/WAL/journal/export,
  caches, replay, bounded exports and captured diagnostics. Unknown/conflicting
  classifications, orphan answers, exhaustion and masked attachments refused.
  Failed preflight left every destination session table empty.
- A fresh packed consumer passed runtime codec/Context identity, zero import/factory
  effects, strict ES2022 Bundler/NodeNext checks over 583 contained files, original
  SQLite history/replay/pruning/reopen and the packed source/build helper. Runtime
  and history used 323 and 324 contained module files. All 396 installed output
  hashes matched the qualified distribution.
- Two separate normal builds reproduced all 396 distribution files, and two
  ordinary packs produced identical 1,363,610-byte archives. Source/input maps
  include all changed authored files, every patch, compiler declarations and
  producer inputs; no lock resolution or original codec was replaced.

| Output | SHA-256 |
| --- | --- |
| Distribution file map | `e1a03d84639d83cf25b104681aed44b0fe7312a3d1b0ea0e52ac42ff049071b6` |
| Engine entry | `9bbd362cac09c4ef3738f8c6b529fddb55f429af61330a50da06329f58e6b51d` |
| Engine module map | `1e8645bfe50e0f8d7d22d72b258efa0ec43c71ac7f698d549b0e289a25d62c56` |
| Engine declaration map | `5404a594f8a8ef223d935a450442eced4626a8992ebc70937f3893aeb98f27f1` |
| Engine provenance | `e92026dde457c934a113eef00dac20fe821eb49f9329449cb3fbef473e1c6dd0` |
| Packed archive | `353561ffa84a805888f47158befafaa561592c62b58f3503554cba29a57adfc4` |

Failures remain preserved in the owning worktree's ignored qualification logs:
the initial compiler heap exhaustion, 175 consumer diagnostics, five unresolved
generated directory imports, incorrect replay-envelope fixture, backdated append
fixture, initially invalid attachment fixture ID and scoped lint findings. No
failed check is counted as a pass. A backdated legacy insertion remains an
original-importer failure, not qualified refresh behavior.

This qualifies synthetic passive capture and the generated package, not live
parity. Original-human and physical-source producers, installation coverage,
native history-home custody, canonical vault delivery, T07 publication races and
the entitled gateway/client journey remain required and unverified.

