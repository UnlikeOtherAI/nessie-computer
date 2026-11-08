# Retained T3 capture: source checkpoint

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
never inherit classification from another request or thread. Missing, malformed
or conflicting classification fails the whole capture. Wording is never used.
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
mask flags. Answer values retain their original shape when public. Masked
attachments with nonempty descriptors fail explicitly because their delivery
cannot be reconstructed safely here. Each capture uses fresh classification;
reusing a preflight object is refused. Resume reads only the already projected
generation, and refresh reclassifies source data. Unknown classification is an
incomplete source, never permission to omit a session or claim subset parity.

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

Successful capture/resume returns the admitted source descriptor and the original
source watermark `{ generation, sequence }` alongside local readiness. The
sequence is the journal's captured source high-water, not a destination sequence
created by legacy hydration. Physical root, environment and capture generation
must accompany every parity observation. The producer must still prove its
actual source revision and installation coverage; a supported layout is not
revision evidence and this return value grants no authority.

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
edges/orphans and retained native overlay/tombstone aliases. It has NOT RUN in
this source lane. The added `privacy-destination.test.mjs` uses original package
state/read/importer interfaces and the supported readonly capture port. It
asserts masked defaults/options/answers are absent from all destination SQLite
exports and main/WAL/journal files, original event replay, repeated cached reads,
bounded wire exports, diagnostics, resume and refreshed legacy history. It also
asserts missing/unknown/conflicting masks, orphan answers and capacity exhaustion
retain the prior catalog instead of reporting success. These tests are authored,
NOT EXECUTED. Full attachment delivery, strict consumer
qualification and separate Node 22 readonly-capture execution remain required.
The new privacy namespace export changes runtime/types/provenance;
the prior 5013e582 normal-package qualification is historical input evidence.

The privacy registration now binds reviewed commit `7567a431d3404a0c3a2610c23bebbc4e8eb6ff5f`,
manifest `98310d0219cab3a2183a9cb5ca9215823a42afb66bd9a0a830aed59f19b0a3c9`
and composed manifest `8abd5bb0fd7818503b849a65a05440c1522fcdc1001b4fbd91f106e9cd65b6f1`.
Importer files remain ordinary executor consumers, outside the generated engine
graph; only the already registered `core/Engine.ts` gains the privacy namespace.
No authored-input wildcard or unrelated lock resolution is added.

No compiler, install, Node 22 candidate, PostgreSQL, native, browser, service or
provider job ran here. Private lock integration belongs to root: preserve private
pins and use pinned 10.22 frozen metadata validation plus full dependency-reference
and integrity checks. Public lock edits change only this consumer importer; no
package/snapshot resolution records are repinned. T07's actual PostgreSQL
root/source race awaits its bound port and an explicit T03C-free lane. Installed,
real-user, provider, gateway/client and end-to-end evidence are all unclaimed.
