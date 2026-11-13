# Retained catalog publication

Status: implemented source, unqualified. The producer calls T07's real signed
`createT3CatalogPublicationTransport`, consuming the exact publication-purpose
lease from the parent-integrated import owner. No test or native journey has run.

## Held graph and production call site

Runtime calls `withHeldRetainedCatalogGraph(ports, held.local, use, held.signal)`
inside `withRetainedRuntimeSource`. The required fourth argument is the runtime
wrapper's sticky-abort signal. The actual `RetainedImportLocalContext` owns the
source object, database and original physical recheck callback. No source port
is recreated and no physical database is reopened.

The factory resolves the journal's exact ready generation, opens that captured
stage once, and builds the original state/read layers once. Its callback receives:

- `source`, `captureGeneration`, `sourceHighWater`, `localCatalogReference` and
  `readiness: 'retained-read-only'`;
- `signal` and `recheck()` for source, consent and generation currentness;
- `createReadService(authority)`, returning the same finite RPC/HTTP handlers as
  `createRetainedCatalogService`, over this captured graph;
- `publish(authority, state, signal?)`, which constructs the canonical
  `T3CatalogPublicationPort` and calls `publishLocalCapture` with the actual
  journal-bound local reference.

The distinct authorities come from `held.local.authority(serverLease)` with the
actual catalog or publish purpose. Publication consumes
`withCatalogPublicationScope` and its issued `publicationGrantId`, `selectionKey`,
selection and `recheckSelection`. Caller parameters cannot substitute them.
`RetainedCatalogPublicationAuthorityPort` and its scope live in
`catalog/selection.ts`, consumed by the real `ownership/import-scope.ts` producer.

The runtime wrapper checks the real physical/local consent lease every 20s during
unrelated waits. This is below the physical reader's JS55s/native60s idle limits.
Checks before/after dependent awaits do not extend consent's five-minute or the
server lease's 60s hard deadline. First rejection aborts the shared graph. The
callback must observe `graph.signal` and drain its lane. The graph tracks enclosing
authority/publication promises as well as joined SQL operations, aborts and drains
pending work before SQL closes, and rejects every escaped handler after closure.
No provider, executing lifecycle, native association or writer transfer follows
from passive graph readiness.

## Ordered metadata and receipts

The producer enumerates original captured V2 projection rows using the exact
`ProjectionStore.selectShellThreadRows` order: `updated_at ASC, thread_id ASC`,
including SQLite UTF-8 tie comparison. Keyset pages contain at most 128 entries;
there is no OFFSET, timestamp cutoff or 5,000-row catalog truncation. A selection
predicate applies before paging. Only selected journal identities are checked.
Titles and expressly entitled project references are source index metadata;
transcripts, provider records and inherited content are never queried here.

T07 confirmed the wire mapping: `groupPath: [environmentId]`, group ordinal zero,
and contiguous source row ordinals. This preserves source-query order; it is
not the person's mobile/preference grouping. The original T19 browser reducers
still own that grouping. `sourceStorageKey` is the exact original `thread_id`,
`sourceSchemaVersion` is the original projection constant, and
`sourceMigrationRef` stays null because this producer has no migration receipt.
It never invents copy or historical-human provenance.

Two passes run in one captured-database transaction. The first computes immutable
selected counts and SHA-256 over the source identity, capture fingerprint,
generation, watermark, exact selection and canonical ordered pages. The second
sends the same bounded pages and verifies the digest/counts again. Each encoded
page is capped at 1 MiB, below the signed route limit. An oversized or invalid
original value is a failure, never silent truncation. The protocol's own finite
count limits remain explicit validation limits.

The signed transport sends `t3.catalog.page` followed by `t3.catalog.complete`
to the existing private daemon route. There is no separate start action. A zero
entry selection emits no pages and completes with zero counts. Whole-source
completion is emitted only for `selection.scope === 'environment-owner'`; a
thread selection emits selection completion and must account for every selected
ID. The producer rechecks the canonical selection at page boundaries and before
completion. Local row checks do not make one HTTP authority exchange per identity;
the publish lease and T07 intake both validate the actual selected scope.

The server never receives or dereferences `localCatalogReference`. T07 serializes
current root/grant/mapping checks and returns its immutable receipt. The producer
checks publication identity, generation, selection, counts and completion. The
120s operation bound does not renew a shorter authority deadline. Timeout or lost
response preserves staging and receipts; an explicit retry sends identical pages
and reconciles them through the existing backend. Changed metadata at an existing
ordinal is rejected. An obsolete generation or revoked selection cannot complete.

This is a finite machine publication doorway, not a new WebMCP/MCP bypass. Tools
continue to use the entitled catalog/read facades and original operation schemas.

## Qualification still required

`test:t3-session-catalog` includes the authored publication fixtures. They use the
real engine, capture, held graph, original read handlers and signed transport,
with synthetic source/authority and an intercepted server endpoint. They cover
5,007 identities, bounded source order and Unicode ties, archive/tombstones,
single captured-SQL acquisition, shared/empty selections, absent hidden project
references, lost response/retry, selection/generation/cancellation loss and the
outer authority promise draining before source release, and sticky local consent
loss even when a callback catches the error. Catalog reads validate the complete
canonical selection without making a remote lease exchange for each catalog row;
exact-thread reads retain individual checks. These fixtures are not proof of
native consent, UOA admission or the real PostgreSQL transaction.

Bounded builtin Node syntax checks passed for the nine changed/new TS/MJS files,
along with JSON parsing, the 500-line cap, `git diff --check`, and a static match
against the pinned original source ordering. No imports, SQL or tests executed.
The parent
must run the combined normal build/typecheck and catalog/import gates, followed
by the actual protected consent -> capture -> ordered page publication -> Dev
catalog/history journey. Exercise lease expiry/revocation, replacement, dropped
response and reconnect through UI, WebMCP and internal/external MCP. Record the
exact integrated revisions, source generation and real receipts. No live user
capability or runtime qualification is claimed by this source checkpoint.
