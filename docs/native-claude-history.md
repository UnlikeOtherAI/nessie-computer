# Native Claude history source

This source checkpoint implements Claude discovery and finite history paging.
It does not establish a live Nessie capability. The canonical resource and
original-person read producers remain unbound; no personal history was opened
to develop or verify it. T3 threads using Claude remain T3 identities.

## Operations and admission

`NativeClaudeHistory` in `src/t3-session/native-sources/claude/index.ts` is the
single consumer for future UI, WebMCP and internal/external MCP registration.
Those registrations belong to their respective owners. Both operations are
finite reads, with no provider writes, mutation receipts or streaming handle:

| Operation | Input | Result and retry |
| --- | --- | --- |
| `catalog` | `target: {source: 'claude', admittedRootKey}`, optional `{generation, offset}` cursor, `limit` 1–200 | Source-labelled rows with exact native IDs, independent opaque history IDs, nested agent IDs and parent references. Same-generation retries repeat a page. A changed catalog rejects an old cursor. `sourceComplete` and reasons distinguish incomplete discovery from the last page's `complete`. |
| `history` | The same target plus `historyId`, optional `{historyId, revision, offset}` cursor, `limit` 1–200 | Supported native records in file order, with original IDs and byte positions. Retries retain the same cursor. Replacement, modification or append invalidates the old snapshot cursor. A partial last record remains incomplete at the same position. |

`ClaudeHistoryReadPort.withReadScope` is REQUIRED and UNBOUND. Its canonical
producer must admit the exact human, selected team, executor, source and root,
hold the canonical native history resource and provide fresh physical/current-authority
rechecks. `recheckHistory` authorizes each exact discovered history before
publication or opening its bytes. A root discovery grant cannot grant every
history read. Rechecks run during enumeration, at record boundaries and before
return. No public factory creates this authority from callbacks or JSON; test
ports are explicitly synthetic. A caller-supplied port is not deployment proof.

The actual admitted gateway must supply this producer, preserve these errors
and cursor semantics, and apply the existing path/secret display projection.
Missing admission fails before any resource access. A path-only lease is
rejected. The production Claude consumer contains no filesystem open, stat,
realpath or directory enumeration: it consumes only `HeldNativeHistoryRoot`
capabilities issued by the protected native resource owner. Root discovery reads
only admitted entries and file metadata; history bytes are read from the same
held native file only after the specific history check. Credentials,
provider-account files and title indexes
are never read by this adapter. Native stop, custody handoff, resume, queue and
writer creation are unavailable.

## Inventory and history fidelity

The supported layout is `projects/<project>/<native UUID>.jsonl` and
`projects/<project>/<native UUID>/subagents/agent-<agent ID>.jsonl`.
Old, empty and nested files are retained. Different history paths for the same
native ID are separate identities; source, admitted physical root and exact
relative history location determine the opaque history ID. Titles and working
directories never select identity. Parent references may remain unresolved if
the parent file no longer exists; children are not dropped.

Catalog ordering is descending file modification time with exact history path
as the stable tie-break. This is Claude file inventory ordering, not T3 app
grouping. No native archive state or live writer state is inferred from a file.
Directory redirects, unreadable paths and unsupported history identities leave
the catalog explicitly incomplete. The resource producer still owes coherent
enumeration custody; a caller-created TypeScript object is not physical or
authority proof. This implementation does not bind the separate physical T3
SQLite producer.

History paging preserves supported text and thinking blocks without the older
tail, message-count or string truncation. It retains original message IDs,
parent IDs and offsets, including duplicate IDs and sidechain records. Native
tool names and call/result IDs remain visible, but tool input and result values
are explicitly withheld as `native_tool_privacy_unbound`. Unknown blocks and
system/account/usage metadata do not leak through a raw-record passthrough;
records report their fidelity. Thus reaching EOF does **not** claim full native
feature fidelity. Explicit `isSecret` markers on native rows, message objects
and content blocks withhold those values; malformed present markers also
withhold, and `false` is distinct from a missing marker. This is structural
projection, not prose inspection. Canonical native tool privacy remains an integration blocker.
Prior plaintext user prose is ordinary history; this is not retrospective
secret removal from native stores.

A record has a 512 KiB byte bound and a page stops after 200 records or roughly
1 MiB, plus at most the final bounded record. Oversized, malformed or
wrong-session records fail explicitly, without advancing past them. A cursor
must point at a record boundary. Unsupported attachment, permission, request
and tool values need the corresponding admitted resource/privacy implementation;
they are not executable callbacks or new permissions.

The existing Claude summary adapter now retains old and empty histories,
propagates scan failures and keeps every candidate transcript path. An ambiguous
legacy native ID returns an unavailable history result, never the last file
found. Recent-message reads require the discovered filename and do not rebuild
one from `cwd`. The older shared `ExistingSessions` facade still has its own
combined cap and summary transport; this checkpoint does not call it a complete
three-source catalog.

## Shared native home proof

`bindNativeHistoryHomes` in `native-sources/history-homes.ts` consumes
`NativeHistoryResourcePort.withHomes` and implements the existing
`NativeHistoryHomePort`. It uses the original
`SourceContracts.OrchestrationV2ProviderThread` type from
`@nessie/t3-session-source/engine`; it does not flatten or recreate that type.
The resource owner must supply the exact admitted root, physical root,
environment, provider thread, app thread, driver and native ID, plus independent
continuation/history home keys and its proof reference. The consumer checks
every identity and rechecks before returning proof.

That resource producer remains REQUIRED and UNBOUND. Paths, labels, credentials,
today's login, an inventory row, a managed launch or a matching native ID cannot
establish an original app association. Two app identities may share one
continuation home and retain separate history overlays. The existing candidate
resolver keeps all of them and reports ambiguity with control unavailable.
This binding grants no read permission or writer custody. Codex consumes the
same shared port; there are no Codex-specific changes in this tranche.

## Protected native producer integration

`native-sources/held-history.ts` defines the local byte/enumeration seam, not a
new grant or wire schema. `HeldNativeHistoryRoot` binds source, admitted root,
physical root and a stable inventory generation. `enumerate({cursor?, limit})`
returns at most 200 issued entries, source generation, next cursor and explicit
completion/reasons. Entries carry an opaque `entryKey`, structural
`relativeName`, kind, revision, size and modification time. The name is never
reopened in JavaScript. `withFile(entryKey, revision, use)` yields a held file
with the same entry/revision, size, `read(offset, length)` bounded to 64 KiB and
`recheck()`. Root and file leases expire at callback exit. The producer must
reject mismatches, revoked grants and stale/replaced resources before bytes.

The existing Windows native seams to extend are:

- `native/src/personal_state/windows.rs`: `pin` and `pin_directories` retain
  ancestor handles without `FILE_SHARE_DELETE` and reject reparses/hardlinks.
- `native/src/state_security/windows.rs`: `verify_owner_only_for` contains the
  owner/DACL policy, currently read by pathname. Held-file admission needs the
  corresponding handle-based check; `windows-common/src/release.rs::secure`
  already demonstrates `GetSecurityInfo` on a retained handle.
- `src/native-control-lease.ts` retains a native child until release; it is an
  existing lifetime boundary, not yet a history byte transport or human grant.

Do not widen `personal_state_context::protected_root` from Nessie private state
to a caller-selected Claude home. The parent must compose a separately admitted
native history root, using the protected ownership boundary and the canonical
prospective source-owner grant. That grant's committed producer is absent from
this worker's base. Current administrator/pairing status, a managed-start
receipt, labels, provider credentials and the physical T3 SQLite lease cannot
substitute for it. No native Rust files or grant schemas are modified here.

## Qualification

The authored source fixtures are
`test/t3-session-native-claude/{homes,history}.test.mjs`. They load exact authored
modules using Node's builtin TypeScript type erasure and only builtin Node
dependencies. Synthetic files stay under this worktree's ignored
`.artifacts/native-claude-source`; no personal provider/session data is used.

The requested serial source gate is:

```powershell
node --max-old-space-size=384 --test --test-concurrency=1 test/t3-session-native-claude/homes.test.mjs test/t3-session-native-claude/history.test.mjs
```

At the follow-up checkpoint, builtin syntax checks passed for all six native
source modules and the modified fixture JavaScript; whitespace checks passed.
Eighteen source fixtures are authored. The source suite, package typecheck/lint, production wiring and manual
UI/WebMCP/MCP journeys have not run. The parent coordinator owns the serial
qualification window and shared package/Turbo registration. No compiler,
database, provider, server, browser, native build or installation was started.
