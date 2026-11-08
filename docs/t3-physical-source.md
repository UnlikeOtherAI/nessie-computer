# Held physical T3 sources

Status: Windows source implementation, **not compiled, run or installed-qualified**.
Historical-human authority and server publication remain unbound. No provider or
T3 serving process is started. Other platforms refuse; all-machine coverage is
not claimed.

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

## Windows reader and supported limits

The packaged native `t3-source-read` command verifies its compiled publisher EKU.
Windows 11/local fixed volumes are the qualification target. Kernel file IDs and
volume-GUID final paths are required. UNC/network roots, symlinks, junctions,
other reparse components and unsupported filesystems refuse. Ordinary aliases
are equivalent only when their held directory file IDs agree.

Every directory component is held without delete sharing. Subsequent file and
SQLite opens use the held volume-GUID namespace, so drive-letter/SUBST remapping
cannot redirect them. Main/WAL/SHM identities remain held without delete sharing;
the environment file also excludes write sharing. ACL checks inspect those
handles, not a second pathname lookup. Directory change notifications stay
signalled: replacement followed by restoration also refuses. Source name/security
changes and executor-state directory writes conservatively invalidate a lease,
including unrelated changes in those directories.

The helper owns a real `winsqlite3` read-only connection throughout the callback.
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
The native watchdog bounds blocked clients/SQLite at 60 seconds; TypeScript
refuses after 55 seconds. Expiry leaves capture incomplete. Larger captures need
a future bounded renewal design; automatic renewal is not claimed.

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
nor original-client extension is implemented here.

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

## Authored qualification; none run

This source/tiny lane ran only source reads/edits and whitespace checks. No
dependency install, compiler, runtime test, SQLite fixture, native build,
provider, personal session or installed-state operation ran.

After a separate Maxis lane assignment, prepare this worktree's own dependencies
and run normal executor build/typecheck plus focused adapter/import gates through
the public Turbo graph. Build/test only the changed Windows native helper:
`cargo test --manifest-path native/Cargo.toml t3_source -- --test-threads=1`.
Native tests author real WAL reads, original chronology, aliases/distinct roots,
replacement attempts at protocol boundaries, revocation, role changes, expiry,
missing/corrupt/reparse/traversal/ACL refusal and authenticated pipe delivery,
tamper, replay and wrong-client rejection. Symlink tests require Windows symlink
permission, with no silent skip.

`test:t3-physical-source-installed` requires the exact candidate's packaged Node
and signed helper after source/hash/publisher verification; no helper override is
accepted. It exercises the registered producer, callback identity, chronology,
simultaneous aliases, unavailable roots, schema failures, revocation and final
return refusal. Native unit tests do not qualify that public signed command or
installed protected launch. T03C's unintegrated branch and prior tests supply no
positive proof for these changed bytes. Other platforms and all-machine/session
parity remain unclaimed.
