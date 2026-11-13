# Held physical T3 sources

Status: Windows source implementation, **not compiled, run or installed-qualified**.
Historical-human authority and server publication remain unbound. No provider or
T3 serving process is started. Other platforms refuse; all-machine coverage is
not claimed.

Execution-only settings and opaque provider-home handles use a separate
[protected graph resource scope](t3-execution-resources.md); retained consent
does not authorize them. Its native gate and installed qualification remain
required independently of this reader.

## Owning surface

The existing local `configure --configuration-input-stdin` policy accepts
`t3SourceHomes`. Omission preserves policy; `[]` withdraws it. Each entry contains
`admittedRootKey`, `kind` and `stateDirectory`, for example:

```json
{"admittedRootKey":"desktop-one","kind":"configured-home","stateDirectory":"C:\\explicit-t3-home\\userdata"}
```

Include the command's existing operation/folder policy fields as usual. These
are explicitly selected original state directories, not search parents. Paths
remain in owner-only executor state outside checkouts, never the server
descriptor. Registration grants local resource permission, not historical
originalness or human ownership. The reader never secures or modifies T3 files;
a source with a broader-than-owner/SYSTEM DACL is refused.

`serveExecutor` registers the resource after its existing daemon lease/claim.
`machineT3Sources(executorId)` exposes `manifest`, `withReadonlySource` and
`recognize`; daemon shutdown withdraws all issued bindings. No injected opener,
recheck callback or serialized descriptor can mint a binding. The native receiver
independently reads the local configuration and checks executor, revision and
the entire root manifest before following its selected entry.

Manifest order, aliases and unavailable entries are retained. A callback for one
root does not report complete machine coverage. Missing roots are incomplete,
not empty. The existing capture journal's immutable alias/root binding and sticky
conflict transaction remain the publication gate. Distinct roots with the same
environment are candidates, never merged or automatically elected. T07 must
retain that rule in its server transaction.

This is the T3 source, independently of the provider running its turns. It does
not substitute native Codex/Claude inventory for T3 membership or merge an exact
native association into its T3 primary identity. All/T3/Codex/Claude sectioning
and comparison against the complete original per-machine catalog remain the
next catalog consumer's work, as clarified in private scope `0a2c45b357`.

## Windows reader and supported limits

The packaged native `t3-source-read` command verifies its compiled publisher EKU.
Windows 11/local fixed volumes are the qualification target. Kernel file IDs and
volume-GUID final paths are required. UNC/network roots, symlinks, junctions,
other reparse components and unsupported filesystems refuse. Ordinary aliases
are equivalent only when their held directory file IDs agree.

Every directory component is held without write or delete sharing; a pre-existing
write-capable directory handle also prevents admission. This excludes in-place
reparse mutation, not just rename. Type/reparse state is checked again on all
held directory objects. Subsequent file and
SQLite opens use the held volume-GUID namespace, so drive-letter/SUBST remapping
cannot redirect them. Main/WAL/SHM identities remain held without delete sharing;
the environment file also excludes write sharing. ACL checks inspect those
handles, not a second pathname lookup. Directory change notifications stay
signalled: replacement followed by restoration also refuses. Source name/attribute/security
changes and executor-state directory writes conservatively invalidate a lease,
including unrelated changes in those directories.

The helper loads `winsqlite3.dll` by its absolute System32 name with the restricted
system-library search flag, checks the loaded module pathname, and retains its
typed function table for the process lifetime. An application-directory/PATH
substitute or preloaded same-name DLL elsewhere is refused. It owns a real
SQLite read-only connection throughout the callback.
The documented `SQLITE_FCNTL_WIN32_GET_HANDLE` and `SQLITE_FCNTL_JOURNAL_POINTER`
controls bind SQLite's actual main and WAL handles to the held file IDs before
issuance and on every recheck. A system SQLite without those controls refuses.
There is no cast into SQLite's private WinFile/pager layout. SQLite exposes no
equivalent public SHM handle: its SHM namespace is pinned by the held directory
chain/file handle, with sticky attribute/name/security notifications and checks
around every operation. Any observed mutation refuses the entire lease.
TypeScript never checks one file and later opens SQLite elsewhere. Its synchronous
adapter sends closed named reads, not SQL. Both sides share one fixed table/column
catalogue. A SQLite authorizer independently denies credential/auth tables,
ATTACH, writes, unrelated functions and schema tricks. No raw database backup,
provider history, attachment bytes or credential home is copied. Transactions
retain WAL-visible original values and ordering. Historical value projection
still belongs to the capture consumer.

WAL mode requires existing readable main/WAL/SHM files; missing sidecars refuse,
without `immutable=1` or sidecar creation. Rollback mode requires OS write sharing
exclusion and no journal/WAL/SHM, so an existing writer can make it unavailable.
Corrupt or unsupported SQLite/layouts refuse. Rechecks run before and after each
native operation, throughout the callback and immediately before producer return.
The native watchdog bounds its own idle/blocked pipe or SQLite operation at 60
seconds; TypeScript refuses after 55 monotonic seconds without an authenticated
response. Callback cleanup waits for the native child to close its handles.
Each successful operation renews only after fresh native configuration, handle
and ACL checks. Expiry is irreversible. This permits long captures without
truncating rows, while an idle callback expires. It renews no human grant;
canonical historical-human freshness/revocation remains independently required.

The named pipe uses an owner/SYSTEM DACL, first-instance creation, local clients
only and exact client PID verification. An ephemeral MAC key crosses only the
spawned child's private stdin. Direction-separated, sequenced MAC frames
authenticate both endpoints and reject reflection/replay/altered bytes. The key
never appears in pipe names, journals or diagnostics. Failed verification, EOF
or final recheck withdraws the binding. Row/frame/statement bounds refuse rather
than truncate. Driver errors are reduced to opaque failure codes.

## Original storage evidence and provenance limit

Read-only source inspection used T3
`25bf84ab07f53f141c20239c63e383823a9d5ea0`:

- `apps/desktop/src/app/DesktopStatePaths.ts`: explicit `T3CODE_HOME` selects
  `userdata`; development without an explicit home selects `dev`.
- `apps/server/src/cli/config.ts` and `apps/server/src/config.ts`: `--base-dir`,
  `T3CODE_HOME` and `baseDirIsExplicit` select the same layout and `statev2.sqlite`.
- `apps/server/src/environment/ServerEnvironment.ts`: `environment-id` is a
  separately persisted, trimmed value. The reader never creates or repairs it.
- `apps/server/src/persistence/initializeV2Database.ts`: only absent V2 is copied
  from neighboring `state.sqlite`, through a read-only SQLite backup and
  no-replacement hard-link publication. Existing V2 wins. A bad V2 never falls
  back to legacy, even if legacy is newer.
- `apps/server/src/persistence/Sqlite.ts`: original setup enables WAL and runs
  migrations. That write-enabled setup is not used here. Read layouts remain the
  exact migration manifests through 80 or sole-legacy 54.

SQLite's public file-control ABI was source-read at
`sqlite/sqlite@26c9fb8015589dd0b70b27f877feb0649a243ee5` (`src/sqlite.h.in`,
`src/os_win.c`, `src/pager.c`). That is API evidence, not a claim about the OS
DLL's version or a successful test; the system DLL must actually support it.

The initializer records **no durable original-copy attestation**. Current file
ownership, schema, neighboring legacy equality and a first-seen digest cannot
establish that an existing V2's legacy tables still contain its initialization
bytes. They may have changed before admission. The live binding reports
`legacyCopyProvenance: not_attested_by_original_source`; no attested boolean is
invented. Configured role, OS identity and a current consistent snapshot can be
proved. The existing keyed baseline detects later legacy-copy changes; that is
forward consistency, not retrospective provenance. Fresh legacy-54 captures keep
original chronology without asserting a V2 frozen-copy origin.

For future copies, the smallest original-source extension belongs at
`initializeV2Database`: publish an authenticated initialization receipt containing
`version`, installation reference, persisted environment ID, source revision,
migration head, canonical legacy-table digest/algorithm and published V2 file
identity. Bind the completed backup and receipt without replacement, under an
admitted installation signer with an actual trusted verification authority.
Unsigned sibling JSON is not attestation. This cannot certify existing copies.
Those need an explicit canonical migration/admission decision accepting an
*unattested historical baseline*, with that distinction retained. Neither decision
nor original-client extension was part of the initial physical checkpoint. The
subsequent explicitly authorized prospective policy accepts an unattested baseline
without asserting historical provenance; [source consent](t3-source-consent.md)
records its native issuer implementation and remaining qualification/composition.

## Remaining canonical boundaries

The historical owner producer must call this exact daemon owner's `recognize`
with the issued live `physicalSourceRecheck`, compare its `source` object and
executor, then establish original source/thread/human ownership and current
same-person admission independently. That producer remains unbound. Original
`auth_sessions`/pairing subjects describe access sessions;
`orchestration_v2_legacy_imports` records hydration times/counts. Neither alone
establishes immutable thread-to-UOA historical ownership. T03C managed-start
receipts do not establish ownership of legacy/native/external threads either.
Do not import auth stores or derive a human from the local OS account.
T07 publication, staging custody and native history-home proof remain separate.
No private schema, identity/profile store or UOA hierarchy was added.

The returned `LivePhysicalT3Binding` contains the exact issued `source` object,
`executorId`, `databaseIdentity`, `environmentIdentity`, ordered
`sidecarIdentities`, and the explicit unattested-copy status. It is an ephemeral
observation under the recognized function's lease, not serializable authority.
The canonical consumer must separately bind its capture generation, original
thread and original-human ownership generation to current UOA-backed admission.
It must not substitute these OS identities for that evidence. Captured data still
uses the required `RetainedOriginalOwnerPort.withReadScope` call in
`withT3SourceSnapshot`; there is no human-authority factory in this reader.

The next consumer's concrete seam is
`src/t3-session/ownership/continuity.ts:RetainedOriginalOwnerPort.withReadScope`:
its input already carries `source`, `physicalSourceRecheck`, `captureGeneration`
and `purpose: retained-history-read`. Resolve the registered owner by the
canonical executor binding, call `recognize(input.physicalSourceRecheck)`, and
require reference equality `live.source === input.source` plus that executor ID.
Then resolve the existing canonical historical thread/human generation and
current UOA-backed admission, with independent source/thread rechecks. No such
historical record is supplied by this physical implementation. For V2, retain
the explicit unattested status until the canonical migration authority records
its decision or an actually authenticated original initialization receipt exists;
do not treat this status as a successful first-baseline attestation.

## Authored qualification; none run

This source/tiny lane ran source reads/edits, whitespace and parser-only checks. No
dependency install, compiler, runtime test, SQLite fixture, native build,
provider, personal session or installed-state operation ran.
The physical-only `8dad49e` source pass parsed 16 TypeScript files and three JSON files,
checked syntax for the three changed JavaScript test/helper files, and passed
`git diff --check`. It executed no implementation modules. Thirteen native cases,
three adapter cases and seven installed cases are authored, all unrun. The adapter
gate also runs the native-input selector regression covering the shared catalogue.

After a separate Maxis lane assignment, prepare this worktree's own dependencies
and run normal executor build/typecheck plus focused adapter/import gates through
the public Turbo graph. Build/test only the changed Windows native helper:
`cargo test --manifest-path native/Cargo.toml t3_source -- --test-threads=1`.
Native tests author real WAL and rollback reads, original chronology, aliases/distinct roots,
replacement attempts and ACL revocation at protocol boundaries, pre-existing and
new directory-write exclusion, configuration revocation, role changes, expiry,
actual main/WAL handle mismatches and sticky sidecar attribute changes,
missing/corrupt/reparse/traversal/ACL refusal and authenticated pipe delivery,
tamper, replay and wrong-client rejection. Symlink tests require Windows symlink
permission, with no silent skip.

`test:t3-physical-source-installed` requires the exact candidate's packaged Node
and signed helper after source/hash/publisher verification; no helper override is
accepted. It exercises the registered producer, callback identity, chronology,
simultaneous aliases, unavailable roots, schema failures, daemon teardown,
revocation and final return refusal. A V2 fixture checks that the full frozen
legacy copy reaches fingerprinting even when those rows are excluded from the
eligible import projection; the required importer gate separately checks sticky
`frozen_legacy_diverged` refusal. Native unit tests do not qualify that public signed command or
installed protected launch. T03C's unintegrated branch and prior tests supply no
positive proof for these changed bytes. Other platforms and all-machine/session
parity remain unclaimed.

### Exact next-window commands

Run only after a coordinated Maxis reservation and the normal host-memory check.
Use this worktree's independently prepared Node 22.23.1 and pnpm 10.22.0 on PATH;
export the lane's `DATABASE_URL` as required by the repository testing standard
(these focused gates use disposable SQLite, not PostgreSQL).

```powershell
Set-Location 'C:\Users\ondre\.t3\worktrees\Nessie\t3-5d316193\executor'
$env:NODE_OPTIONS = '--max-old-space-size=5120'
$env:T3_SESSION_IMPORT_REFERENCE = 'C:/Users/ondre/Projects/t3code'
pnpm exec turbo run build typecheck --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm exec turbo run test:t3-physical-source test:t3-session-import-source test:t3-session-import --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
cargo test --manifest-path native/Cargo.toml t3_source -- --test-threads=1
```

After separately producing/verifying the exact signed candidate and its protected
launch, use its packaged Node on PATH, with its native helper beside it:

```powershell
$env:NESSIE_EXECUTOR_PACKAGED_CLI = '1'
pnpm exec turbo run test:t3-physical-source-installed --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

That candidate does not exist in this source worktree yet. Setting the environment
marker alone cannot make an unsigned helper pass the compiled publisher check.
The installed gate includes a real 55.1-second idle-expiry case. Run the registered
import gates again against the merged historical projector; its earlier 15/32
qualification is dependency evidence, not a pass for this changed physical path.
Parser-only evidence used system Node 24.19.0 with a 384 MiB heap and imported no
implementation modules. It does not establish types, linkage, SQLite or IPC.
