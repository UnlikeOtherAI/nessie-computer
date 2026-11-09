# Held execution source and destination resources

Status: Windows x64 source with compiler and kernel-component results recorded
below. The protected SYSTEM creator and fixed companion roles are integrated;
images and Job membership alone cannot enable this producer. Signed installed
source enrollment, provider execution and production journeys remain unqualified.
Linux, macOS and other Windows architectures refuse.

This machine-only resource doorway belongs to the separate prospective execution
enrollment and finite command flow. It adds no settings opcode or secret/native
authority to retained read/import consent. The execution owner's local ceremony
and canonical UOA approval remain mandatory. Physical resources prove neither
historical ownership nor original-copy creation; accepted historical baselines
remain unattested.

## Callback and lifetime

`src/t3-session/source/execution.ts` exports
`withT3ExecutionResources({stateDirectory, executorId, admittedRootKey, signal?}, use)`
and `recognizeT3ExecutionResource(scope)`. `stateDirectory` is the startup's
service enrollment reference only: the graph does not open it, load executor
state or receive machine keys. The protected native helper resolves the actual
Windows token's profile using `GetUserProfileDirectoryW`, then only the existing
`.local/state/nessie-executor/<executorId>` source registration. It pins this
owner-only configuration. Service compares its duplicated handle's exact
executor ID, API URL and machine public key with its independently held paired
service enrollment. Missing registration or a different enrollment refuses.
No source configuration or machine key is copied between registrations.

Before opening source DB/settings, a missing or changed linkage requires a
secure-desktop source-owner affirmation. The native prompt displays the actual
registration/source directories, admitted key, owner SID, paired origin and
configuration/public-key fingerprints. It uses six locale translations and
the existing shared OS approval primitive. Service tracks the exact review
helper generation, held configuration and digest; only that fixed protected
native role can confirm after obtaining `AffirmedOwner`. A CLI boolean, daemon
JSON or another helper cannot confirm it. This bounded ceremony is a local
source-registration link, separate from execution issuer/UOA/command authority.
Link version 2 explicitly grants local reads of **settings and session snapshots**.
Its `sourceAccess: settings-and-session-snapshot` value participates in the exact
stored metadata match. A version 1 settings-only link cannot silently enable
session reads; it requires another protected local affirmation.

The service-owned `execution-source-links/<executorId>/<SHA256(admittedRootKey)>.json` stores only
product-specific linkage metadata: owner SID, exact configuration identity,
digest/revision, admitted key/actual physical root, executor/public-key digest, paired API origin and enrollment
digest. It stores no homes, keys, profiles or org hierarchy. Replacement or a
different revision/digest/enrollment requires another explicit affirmation;
there is no automatic migration. Observations only cover periods with held resources;
they cannot attest to changes made and restored between scopes. Live resources recheck
both registration and link throughout. Settings are
always `<original stateDir>/settings.json`. Missing, corrupt, over-1-MiB, reparse,
unavailable or non-owner-only settings refuse; absence never creates defaults.

The callback receives `settingsBytes`, `receipt`, `providerReferences`, `signal`
and `recheck()`. Runtime9 alone decodes with `Schema.decodeUnknownSync(ServerSettings)`
from `@nessie/t3-session-source/contracts`; original `ProviderInstanceConfig` and
`ProviderInstanceConfigMap` codecs remain authoritative. The original
`Settings.ServerSettingsService` tag comes from `/engine`. Inspect must not
create the live provider registry or run its startup SecretResolver hydration.
Driver construction and secret resolution require later finite command admission.

Recheck before and after decode, every dependent await, each native/effect phase
and final return. Automatic 20-second physical checks abort on loss without
renewing human/backend authority. Closure invalidates recognition and zeroes
the original byte buffer. Escaped scopes refuse. Never copy/log/serialize/return
settings: original files can contain inline credentials. Buffer zeroing does not
claim to erase every transient V8 JSON/base64 representation.

## Native execution destination ownership

`T3ExecutionResourceScope.withDestination` now retains a native destination owner
around the original execution-state workspace. Native resolves the actual token's
profile and the fixed local layout using the executor ID and held physical source
key. The graph supplies no path. The existing owner-checked directory preparation
runs first; original journal, writer and stage SQL connections open only after
native pins that directory's complete no-reparse namespace.

The native owner opens `native-execution-owner.lock` with read/write access and
zero sharing. `OPEN_ALWAYS` preserves the lock artifact. A competing owner,
preexisting incompatible handle, rename or deletion refuses. Service independently
resolves the actual peer's fixed directory, compares the real directory identity,
and duplicates the writer handle and sticky metadata watches. It mints the
`destination-sha256:...` runtime generation from those held objects and a fresh
native nonce; the graph no longer invents its execution writer generation.

Only the authenticated resource companion can register destination files. The
private wire accepts `journal` or an exact `t3-capture:v1:<lowercase SHA-256>`
reference, never arbitrary SQL or a path. Native and service retain each actual
single-link, owner-only main file before the original SQL layer opens it. Contents
may change through SQLite; omitted DELETE sharing pins the file name. The graph
uses the native volume-GUID path for all SQL opens, including the original state
writer. A drive-letter alias is not reintroduced by `realpath`.

Local receipt schemas contain identities and the writer generation only. The
canonical destination path crosses only the private resource channel into its
fixed graph, never a daemon/backend DTO. Scope recognition refuses serialized or
escaped destinations. Passive retained captures keep their own namespace and do
not acquire this native owner. Graph acceptance now checks the held destination
writer generation and exact stage reference derived from the capture generation.

Callback exit joins the original SQL and state-writer finalizers before requesting
native destination close. Source loss or uncertain close cannot stand in for that
drain: service retains destination handles against its already-held actual graph
process handle until the process ends. Creator and custody reconciliation release
those handles before recording positive graph clearance, after their existing
process/Job checks. Cleanup never deletes a journal, stage or writer artifact.

Destination ownership grants no startup/recovery write, row claim or provider
launch. The independent reader below returns unsigned facts only; a current
finite backend admission remains required. Existing reserve, graph and FRAME
authority do not authorize a claim.

On Maxis, 9 November 2026, the strict source/protocol/CLI build and all 109 runtime
cases passed. The Windows common suite passed 61 cases, service 71, and native
helper 78 plus five Job cases, with zero ignored tests. Real kernel cases cover
exclusive writer/ancestor lifetimes, sender-close duplication, actual mutable
SQLite contents, hard-link refusal and process-observed retirement. The elevated
fixture stamps its user at file creation; strict native ownership stays unchanged.
Runtime transport doubles exercise metadata/refusal and drain ordering only.
These checks do not qualify a signed installed resource entry or provider launch.

The direct machine-only package interface was exercised at public
`f914883154099963d50c125e9568eab60d8f1d87` on Maxis/Node 24.19.0. An external
fixture used actual Windows directory/writer/main-file handles and the kernel's
volume-GUID spelling. The original state writer kept that spelling and the
original Sqlite layer updated/read the database while pinned. A competing writer
and directory rename refused; rename succeeded after all pins closed. Evidence,
SQL files and logs remain under
`D:/BuildArtifacts/nessie/t3-7a4698a9-verification/destination-volume-61655e98-3b67-4cb7-801d-04fc6c2a4df5`.
This probe supplied no native grant or provider. The newly built unsigned helper's
actual `t3-execution-resource` entry separately refused an unprotected launch with
exit 1 and `t3_source_resource_changed_or_unavailable`. No installed source was opened.

## Independent pending-effect observation

`T3ExecutionResourceScope.inspectPendingEffect(graph, effectId)` uses the existing
authenticated resource companion. The service requires the exact previously
accepted Graph payload and nonce, current source/custody and its held destination
stage for that capture generation. Callers supply no path, SQL or clock. The
initial Graph receipt's five-second freshness is not reapplied as resource lifetime.

The service opens its own read-only system SQLite connection to that actual
held stage. Before opening SQLite it checks the main header's journal mode and
holds the required WAL/SHM files without DELETE sharing. Missing WAL-mode
sidecars refuse without creating files or using an immutable/rollback fallback.
Sticky namespace/security witnesses and independently held file identities are
rechecked; public SQLite file-control calls verify the actual VFS main/WAL handles.
One transaction reads the row and matching accepted command receipt. The fixed
authorizer permits only those ordinary tables, exact schema inspection and the
read transaction; writes, private tables, extensions, ATTACH and mode changes refuse.

The exact physical schemas are required: 14 outbox columns, including
`lease_expires_at`, and eight command-receipt columns. Unknown/missing columns,
views, persisted triggers, incoming foreign-key references, duplicate-key payload
JSON and mismatched file witnesses refuse. A missing,
foreign or nonpending row, or absent matching accepted receipt, returns `null`.
The response contains identifiers, observation time and full row/payload/receipt
hashes, never raw payload/error text. Observation time starts before reader I/O.
The native source reader now shares its existing system DLL/readonly connection
implementation with this service reader, retaining its separate static policy.

The same resource's `inspectProcessLoss(graph)` now reads the entire original
global recovery set from that held stage. It returns unsigned digest/count
facts, matched against the scoped original outbox plan in the existing
inspection context. Its [row-plan contract](t3-process-loss-plans.md) describes
the exact conditional transaction, writer-local TEMP-trigger guard and remaining
lifecycle authority. This read never starts recovery or a provider.

`inspectRecoveryInputs(graph, threadId)` reads the original recovery projection's
thread and ten section queries from that same held destination. The query
descriptor is generated from the pinned original SELECTs; callers provide no
SQL, path, section list or digest. The original projection reader shares those
SELECTs and can return their input digest alongside its normal decoded result.
The digest retains exact logical SQLite TEXT and original section/row order,
including whitespace that the original codecs normalize. Ordinary reads keep
their existing decoding behavior and do not compute this digest.

The native observation requires twelve ordinary projection tables and one
read-only transaction. It returns only thread ID, digest and observation time.
Its five-second wall and monotonic budget starts before opening the snapshot;
a SQLite progress callback bounds VM work, and a final check includes file
verification and commit. More than 16,384 selected rows or 4 MiB of encoded
inputs refuses without truncation. This is unsigned input evidence; it does not
independently select the complete shutdown action or authorize any mutation.

The separate [shutdown admission](t3-lifecycle-authority.md#finite-original-shutdown-preparation)
now combines those same private reads with independently held settings, original
candidate selection, native continuation selection and exact existing outbox
slots. Its receipt/consume methods remain distinct from the unsigned per-thread
input query. No caller SQL, candidate effect set, path or settings bytes is accepted.

`T3ExecutionPendingEffectObservation` is explicitly unsigned. The original durable
receipt records command type and result sequence but no parent-command edge;
accepted status cannot establish this graph's original operation relationship.
The live original recorder owns that edge. Its protected capture below can now
bind the unsigned row facts to that relationship. No signer, claim domain,
backend consumer or positive preclaim owner is added here.

On Maxis/Node 24.19.0, the pending-row checkpoint passed all six source/protocol/
CLI build tasks, 15 producer, 14 privacy, 40 source, 13 engine and 112 runtime
cases, with zero skips. Common passed 63 cases, service 77 (including six actual
destination-reader cases), and native 78 plus five Job cases, with zero ignored.
Both locked Windows debug binaries built; producer/TypeScript lint, changed-code
line caps and whitespace checks passed. The shared native reader's full source
regression remained green after the refactor.

A direct package-interface probe outside the test runner verified the shared
14-field digest, stale physical lease-expiry refusal, one low-level conditional
transition, consumed-token refusal and unknown-column refusal. It exposed a
cached `SELECT *` metadata gap; the outbox now checks live `table_xinfo` rows
during preparation and inside the actual conditional UPDATE. The regression
also changes the schema after preparing a candidate. Evidence and the retained
synthetic SQLite database are under
`D:/BuildArtifacts/nessie/t3-7a4698a9-verification/pending-row-interface-lxEaJw`.
The new unsigned helper again refused an actual unprotected resource entry with
exit 1. These checks exercise no positive SYSTEM graph, native signature, backend
claim admission, provider or installed source enrollment. Production `open`
still refuses; startup/recovery and parent-operation authority remain unfinished.

## Protected original command capture

`withOriginalCommandLineage(graph, retentionExpiresAt, signal, use)` retains a
private sink on the same authenticated resource channel. The original recorder
reports only the IDs it captures at initial-message creation, accepted initial
run, prepared-release creation and accepted release. The service requires the
exact previously accepted Graph, source/custody, destination and selected
thread/provider. It never derives child IDs from spelling or uses event
`correlation_id` as parentage; the original persistence layer repeats the child
command there.

The service keeps one capture per original parent in that resource incarnation.
Exact open replay retains its original graph digest and deadline; a changed
graph nonce/cap, invalid phase/edge or retirement cannot reopen it. The canonical
ACK expiry supplies a retention cap only, not authority. The original receipt's
five-second freshness is not reused as selection lifetime. Native retention
also has an elapsed-time bound, and observed expiry is terminal across clock
rollback. No resource handle or durable row is deleted to retire a capture.

Initial acceptance independently reads the accepted parent (`thread.create` or
`thread.metadata.update`), accepted `message.dispatch`, and its actual
`run.created` event from the held destination. Release acceptance rechecks those
exact digests, then the accepted `prepared-run.release` and its `run.updated`.
The fixed reader requires the exact 14-column ordinary event table and eight
receipt columns, strict duplicate-key-free JSON, selected run/message/provider,
the original child correlation and preparing/starting states. Event sequences
must follow their predecessor receipts and fall within the corresponding
accepted result sequence. Missing/pruned, duplicate or substituted records refuse.
It checks the selected structural fields and hashes entire SQL rows; it does not
claim an independent implementation of every original event codec.

`inspectBoundPendingEffect(graph, effectId)` is a distinct unsigned read. One
transaction matches a pending `provider-turn.start` to the captured release/run
and rechecks all five stored receipt/event digests. Another run/command returns
no match; changed accepted evidence refuses. The result contains the full raw-row
digest and original ID/hash metadata, with no raw payload/error, path, signing
key or claim callback. A parsed result cannot become `T3ExecutionReceipt`.

`withReservedSessionLaunch` supplies the real resource sink to the existing
original registry after reserve acceptance. Normal original-owner closure,
substitution, interruption and parent/source loss withdraw the native metadata.
The sink is unusable after return; pending calls join. Uncertain open/retirement
invalidates the source, whose existing finalizer joins positive native cleanup.
Successful provider cleanup may retire the recorder before callback return;
the enclosing parent and source must still be current.

These original capture operations remain evidence only. The separate
[finite preclaim boundary](t3-execution-preclaims.md) now supplies the native
observation/consume, canonical backend admission and original conditional SQL
handoff; its signed installed positive journey remains unqualified. Startup/
recovery, full activation and signed installed enrollment/provider journeys
remain unfinished; production `open` stays refused and generic stdin stays denied.

On Maxis/Node 24.19.0, the combined six-task build and a final CLI rebuild passed;
the unchanged source-engine task reused its verified cache. All 117 runtime,
67 common, 81 service and 78 native unit plus five Job cases passed with zero
skips/ignored cases. The four new native SQL cases use real Windows files/WAL
and independently query the receipt/event tables. Five runtime cases invoke the
actual original recorder with a metadata-only channel double, checking exact
phase order, retirement, argument capture, cancellation joins and uncertain-close
invalidation. Four common cases cover accepted predecessors, terminal substitution,
SQL field/JSON/correlation refusal and monotonic/terminal expiry. Both debug
binaries built with locked dependencies; focused lint, formatting, line caps and
whitespace checks passed. No source-family manifest changed.

The newly built unsigned helper's actual resource entry again refused an
unprotected launch with exit 1. The main protected capture/read path remains
unverified through a signed installed entry; the component positives do not
establish SYSTEM creation, enrolled signing or actual provider execution.

## Finite readonly source snapshots

The same issued `T3ExecutionResourceScope` now exposes:

```ts
withReadonlySourceSnapshot<A>(
  use: (snapshot: T3ExecutionSourceSnapshot) => Promise<A>,
): Promise<A>
```

`T3ExecutionSourceSnapshot` is exported from `src/t3-session/source/execution.ts`:
`source: ProvenT3Source`, `database: CaptureDatabase`, `sourceHighWater: number`,
`resourceGeneration: string`, and `recheck(): Promise<void>`. `CaptureDatabase`
is the existing structural type in `src/t3-session/state/sqlite.ts`. It accepts
only the fixed `import/layout.ts` capture SELECTs and schema/migration queries;
`exec` and statement `run` refuse. Runtime owns the separate destination writer
and adapts these reads for the original importer. This port is not a writable
Effect SqlClient and supplies no database path.

The producer owns BEGIN, the first schema read that pins the WAL snapshot,
original migration/table/role validation, and COMMIT or ROLLBACK. It uses the
already-open `ExecutionResource.source.database`; no second reader, source
copy, attachment, provider startup or original T3 server is created. A private
native snapshot token binds each fixed query/cursor to that transaction. Only
one snapshot may be active. Closing finalizes abandoned cursors; old tokens and
escaped statements cannot read the next snapshot. Callback failure invalidates
the resource. Returning from the outer scope with an unfinished snapshot refuses.

Every native read, row step, finalization and transaction return checks the
physical source before and after, with the execution handler additionally
checking current service-held registration, settings, graph custody and ACLs
before any rows leave the protected channel. Recheck around every dependent
await in the consumer. The native resource generation identifies this held
lease, never the destination writer/capture generation. Ordinary source WAL
appends are consistent within the pinned snapshot and visible to a later one.

This prospective local read grant supplies no historical-human or publication
authority. The fixed catalogue retains original V2/sole-legacy roles, table
filters and order. Runtime9 must apply the existing original historical privacy
projection (including unknown VALUE withholding) before exposing/importing values,
and compare frozen legacy digests against its destination journal before
activation. Frozen-legacy reads remain available through the fixed catalogue for
that comparison. A first observed digest is an unattested baseline, never proof
of original-copy creation. No retained owner/import grant is borrowed or minted.
The shared physical layout validator lives in `source/layout-check.ts` so this
path does not load passive ownership composition to obtain schema validation.

## Native and service boundary

The fixed `t3-execution-resource` native command calls
`execution_context::authenticate_graph` through the authenticated custody pipe
**before** opening settings/source data. Native16 observes the kernel peer,
protected T3SessionGraph parent generation, supervisor, Job, immutable release
and paired executor. Caller PIDs, markers and descriptors confer no authority.
Every resource/link request additionally calls `require_companion_role(...,
CompanionRole::Resource)`: native16's service creator journal must match the actual
peer generation, immutable release and uncleared fixed resource role. Another
protected companion does not qualify. This function is a separate creator
prerequisite; it is not present in the compiler-qualified parent `7b7ad417`.
After that gate, `allow_execution_pipe_observer` grants `PROCESS_DUP_HANDLE`
only to the actual service SID for this native child.

The native child opens the existing supported actual read-only SQLite resource
and pins settings without write/delete sharing. It internally constructs the
registration from real handles; JavaScript cannot submit evidence or handles.
The service duplicates those objects, never checks one path and opens another.
It checks disk type, file ID, reparse/type state, OS-owner ACL, settings bytes/hash,
persisted environment, configured admission, root and provider-home identities.
Native SQLite main/WAL checks remain in the physical reader. Both retain sticky
namespace/security notifications. Inspect opens no credential/history child.

`windows-common/src/execution_resource.rs` defines private `Authorize`, `ReviewRegistration`, `LinkRegistration`, `Register`,
`Recheck`, `Close` requests. The public `execution-resource.ts` schema contains
metadata only; parsing it issues nothing. Settings travel only to the exact
service-observed graph PID through the private-stdin-key authenticated native
channel. The ordinary daemon's retained reader cannot invoke this opcode.

The service owns duplicated handles under a bounded 55-second lease. Real checks
renew physical lifetime only. A watchdog drops entries after native loss or
expiry even without another request. Explicit close releases service handles
before acknowledgement. Native's 60-second watchdog bounds stuck IPC.

`execution_resource::bind_graph(resource_id, caller, context, graph)` checks the
actual held entry before graph signing and every later finite phase. It matches
source/environment/root, exact provider instance/driver/opaque role references,
and runtime/supervisor/service incarnation. First inspection must be fresh;
later rechecks accept the identical accepted graph digest, without extending
backend authority. Changed same-nonce graphs retire the resource. Runtime/source
writer generations are fixed at first binding for the scope. Native
`resourceGeneration` names this registration only; it is not a writer UUID,
capture generation or historical provenance.

## Service-only launch home matching

`service-windows/src/execution_resource.rs` exports within the service crate:

```rust
resolve_launch_homes(resource_id: &str, caller: &Process,
    context: &DescriptorContext, graph: &Graph) -> Result<ResolvedLaunchHomes, String>
match_launch_home(actual_graph: &Process, candidate: &Path,
    resolved: &ResolvedLaunchHome) -> Result<HeldLaunchHome, String>
```

Resolution requires the exact **already accepted** Graph nonce/payload digest,
current source/settings/link lease, owner/session and graph custody, runtime/source
generations, and exact instance/driver/role references. It does not accept a new
Graph or grant an effect. The returned `continuation`, `history`, and `credential`
objects have `canonical_path() -> &Path` and `identity() -> &str` getters plus private
provenance. Paths come from `GetFinalPathNameByHandleW(VOLUME_NAME_GUID)` on the
actual duplicated provider-home directory handles. All matching duplicate aliases
must still resolve to the same object. These structs have no serialization or
wire schema; no paths or keys reach the graph or ordinary daemon.

The matcher requires `actual_graph.generation == descriptor.custody.runtime`.
It opens that retained process's actual token with TOKEN_QUERY|TOKEN_DUPLICATE,
duplicates a scoped impersonation token, verifies its source-owner SID, and
impersonates only while opening the directory chain. Existing thread impersonation
refuses. It never changes token/process ACLs or enables privileges. The protected
creator's existing SYSTEM/service-only token rights supply this access; ordinary
daemon tokens cannot substitute. RAII restores the service identity before any
resource/service-state checks or return. Failure to revert terminates the service
rather than continuing under the wrong principal.

The candidate's whole absolute local directory chain excludes write/delete sharing
and all reparse points. Its final file ID and owner ACL must match the resolved
reference. Retained security notifications make ACL change-and-restore sticky.
Each directory open requests `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
READ_CONTROL`, with `FILE_SHARE_READ` only. `FILE_LIST_DIRECTORY` engages Windows
share-access accounting; attributes/security-only opens do not establish this
exclusion. The native source registration, SQLite namespace and provider-home
chains use the same directory access rule. No ACL is widened. An owner lacking
directory-list access receives a refusal; there is no metadata-only fallback.
No auth.json, history file, secret or other directory child is read. The guard
retains the chain and graph handle until the consumer drops it; `recheck()` checks
both candidate objects and the current accepted resource/Graph. Unsupported paths,
missing token rights, changed generations, revoked links or expired resources
refuse. These are component-source guarantees pending native qualification.

`HeldLaunchHome.canonical_path() -> Result<PathBuf, String>` rechecks before
returning the volume GUID path. There is no immutable DOS-device-map producer:
holding directories does **not** pin a drive-letter/SUBST alias. Preparation must
use this verified canonical path in the actual provider-home environment **before**
hashing/holding Launch, then supply only that held payload to SYSTEM creation.
No post-sign rewrite or raw path equality is valid. Retain the guards and recheck
at preparation, selection, registration, resume and frame use. Original workspace
cwd/options.dir are separate command targets, not provider-home references.
The native preparation owner coordinates exact CODEX_HOME/CLAUDE_CONFIG_DIR
selection with the original runtime adapter; this resolver infers no such mapping
from continuationIdentity and reads no credentials.

## Original semantics and supported references

Read-only source proof is T3 `25bf84ab07f53f141c20239c63e383823a9d5ea0`:

- `apps/server/src/config.ts:deriveServerPaths` defines `stateDir/settings.json`.
- `packages/contracts/src/settings.ts` and `providerInstance.ts` define original
  instance configs and distinguish unresolved secret references.
- Original `ClaudeDriver.ts` registers `claudeAgent` with `ClaudeSettings`.
  Native settings selection accepts that exact source name and emits `claude`
  only in the execution reference wire. Literal source `claude` is unknown and
  issues no references. `CodexSettings.setupMode` and `shadowHomePath` apply only
  to Codex; `ClaudeSettings` uses `homePath` and has neither field.
- `provider/Drivers/CodexHomeLayout.ts:resolveCodexHomeLayout` keeps continuation
  and history on explicit shared `homePath`, including authOverlay; explicit
  `shadowHomePath` is the credential home when present.
- `provider/Drivers/ClaudeHome.ts:resolveClaudeHomePath` defines explicit homes,
  inherited environment and defaults; this producer supports only explicit
  absolute local Windows paths.

Each opaque reference carries original instance ID, driver, role and actual
directory identity, with no path/value. Aliases may share a physical identity
while references remain distinct. `credential` proves an admitted **home
directory**, not auth.json identity/contents, historical ownership or native
session association. Secret-provider credentials need separate finite admission.
No continuationIdentity is parsed into a path. Managed/omitted/default/env homes
produce no executable refs; explicit missing/relative/tilde/traversal/reparse
homes refuse. No scan, original file change or provider setup occurs.

## Integration and qualification

Root's Maxis qualification on public
`a8c282ad3d8666396262c2383391c6ce60eae88c` passed service/helper cargo checks and
54 common tests, but service tests reported 62 passed / 1 failed:
`execution_resource_candidate_keeps_real_directory_identity_across_volume_aliases`.
Its real rename succeeded while both candidate guards were held. The directory
opens requested only attributes/security access, so their share flags did not
pin the namespace. This invalidated the previous directory exclusion claim;
later path rechecks cannot repair that gap.

The correction requests directory data/list access at both actual open sites,
while retaining no-write/no-delete sharing, canonical volume paths and exact
file-ID/owner checks. It does not enumerate directory contents or change the
file/WAL access policy. The original failing assertion remains. Added cases
exercise ancestor and leaf rename/delete attempts without intervening rechecks,
simultaneous volume aliases, preexisting/later DELETE and write handles, and
last-handle release. Native cases extend registration/source wait boundaries
and duplicate the actual settings/home chain into the receiver before dropping
the producer, then require both home and ancestor replacement to stay denied.
These corrected sources and new cases are **not yet compiler/native qualified**;
root must rerun the combined revision in its reserved lane. Source-only
`git diff --check` is not Windows namespace proof.

Native16 public `27649f3efc28b637a58e9820e5017f75095bebd9` defines execution/Custody/Graph
wire; `62f36dd0dfa9dad65a4e6f18ee8cf232c924f104` supplies the refusing protected-process
gate and shared registration. Execution-only transport calls native16's
`spawnProtectedT3Companion('resource')` from `src/t3-protected-process.ts` and awaits
its positive service-cleared `closed` promise on teardown. It never falls back
to ordinary spawn. That SYSTEM creator/facade is a pending separate source
prerequisite; the retained reader keeps its existing direct spawn. Runtime9 owns
the fixed entry and original registry integration.
Root integrates these prerequisites and manifest hunks serially. No sibling
branch was merged or written here.

Authored native cases cover actual bytes/live WAL, simultaneous readers,
pre-existing writers/replacement at waits, original roles, sentinel non-disclosure,
missing/corrupt/oversized/traversal/symlink refusal, real duplicated file identity,
ACL denial, retained-opcode refusal and sticky ACL revocation. TS cases cover
bounded strict metadata and forged callback rejection. All remain unrun.

Receiver component cases use actual duplicated file/ACL/process objects to
exercise retained file locks, environment/digest substitution, expiry and
unlinked-registration refusal. They bypass no production gate and do not
claim positive SYSTEM-created graph admission. A separate wire-only case checks
duplicate roles/objects and bounds; valid wire shape is explicitly not admission.
Native registration cases hold actual configuration/root handles across the review,
dialog and source-open boundaries, refuse replacement, missing admissions and
wrong executors, and verify expiry and overlapping handoff to the SQLite resource.
They never invoke a personal registration or manufacture local affirmation.
Service comparison cases reject mismatched executor, API URL and public key,
missing enrollment identity and cleartext API origins. These are policy tests,
not a substitute for protected service/ceremony acceptance.
The shared `test/t3-session-source/fixtures/execution-settings.json` uses original
`claudeAgent` and `codex` envelopes. A runtime test decodes it with the pinned
ServerSettings, ProviderInstanceConfigMap and both original driver codecs.
The native counterpart substitutes disposable absolute home directories and
verifies all three Claude role refs, exact original instance ID, wire-only
normalization and absence of refs for source `claude`.
`execution_snapshot_tests.rs` authors actual same-connection/WAL visibility,
fixed-row order, abandoned-cursor cleanup, stale-token/sticky refusal, private
table/raw SQL/write/nested transaction denial, retained-opcode denial, and
physical expiry/replacement at query/next/finalize/return boundaries. These
SQLite component tests issue no service admission and remain unrun.
Service component tests also author real directory/volume-GUID alias identity,
retained replacement exclusion, wrong owner, traversal/UNC/reparse refusal and
sticky ACL restoration. Unlinked Graphs still cannot obtain home resolution.
They do not claim positive protected-token impersonation or a provider launch;
those require the installed service/creator lane.

Five TypeScript modules in the snapshot tranche passed non-evaluating Node builtin syntax
parsing with a 192 MiB heap; `git diff --check` passed. No implementation import,
test suite, compiler or native code was executed.

Parent `7b7ad417588be5472179eb5e1474b76cececc528` adds the resource TS fixture to
`test:t3-physical-source`; root reported locked native/service cargo checks on
that parent. Those compiler results predate the registration link and original
Claude selection correction. Run the exact combined revision in root's reserved
Maxis lane:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=5120'
pnpm exec turbo run build typecheck --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
$env:NODE_OPTIONS = '--max-old-space-size=512'
pnpm exec turbo run test:t3-physical-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm exec turbo run test:t3-session-runtime --root-turbo-json=scripts/turbo.public.json --concurrency=1
cargo test --manifest-path native/Cargo.toml t3_source -- --test-threads=1
cargo test --manifest-path service-windows/Cargo.toml execution_resource -- --test-threads=1
```

Export coordinated DATABASE_URL per the testing standard; these fixtures use
disposable SQLite/real ACLs. Symlink permission is required with no silent skip.
The separate installed lane must prove protected graph/helper creation, same-user
injection/handle denial, daemon refusal, local+UOA enrollment, inspect without
provider startup, finite execution, expiry/revocation and drained teardown.

Windows native CI runs kernel/ACL fixtures serially: security notifications
include shared ancestor directories, so unrelated fixtures changing their ACLs
can invalidate an otherwise current pin. Concurrency cases within each fixture
remain active. The complete native-helper unit batch passed 79 tests on Maxis;
this does not establish signed installed execution or provider readiness.
