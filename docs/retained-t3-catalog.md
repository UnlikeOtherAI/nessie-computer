# Retained T3 catalog read composition

This source tranche composes the qualified retained capture with the original
engine's catalog and history reads. It does not establish a running transport,
physical-source admission, original-human continuity, selected-team publication,
live writer, mobile parity or a completed user capability.

The follow-up [held graph and ordered publication producer](retained-t3-publication.md)
reuses these handlers without reopening the source or captured SQL for each
runtime request. Use `withHeldRetainedCatalogGraph` inside the actual runtime
source callback, passing its abort signal; `createRetainedCatalogService` remains
the standalone per-call composition. Both use the same authority/generation guard.

The owning user surface remains Dev and the selected computer's Sessions entry.
Archive, older settled work, family and exact-ID links must use the same session
surface. UI, WebMCP and internal/external MCP owners consume the operation inventory
below through the admitted gateway; they do not call this local composition as an
authorization bypass.

## Composition and authority

`src/t3-session/catalog/index.ts` exports `createRetainedCatalogService`,
`retainedCatalogSlots`, original descriptor types, the operation inventory and
the shared `readRetainedEffect` boundary. The existing three retained wrappers
now use that boundary too. Capture/privacy classification is unchanged.

Construction requires `RetainedCapturePorts` and a `RetainedCatalogSource` with
the admitted manifest/root, physical root, exact environment ID and published
capture generation. These are selected by the admitted host, not accepted as
caller assertions. Catalog reads require the physical producer and the canonical
`RetainedCatalogAuthorityPort` in `RetainedCapturePorts.catalogAuthority`.
That producer owns the actual source/import grant and current team/share checks.
Legacy exact-thread wrappers keep their separate original-continuity path.
No adapter here constructs consent from IDs, paths, timestamps, callbacks or
managed-start receipts, or relabels an import grant as historical ownership.

Every read checks physical identity and its canonical read authority at entry and
before return. The local journal must be available, nonconflicting, ready and
published at the requested generation. It rechecks publication after source and
owner callbacks finish. Refresh, revocation, replacement or abort rejects the
result; a denied read never becomes an authorized prefix or an empty success. Effect
cancellation reaches the original engine query and the surrounding lease checks.
Original typed query failures remain failures; lease and workspace failures are
transport defects, which the outer broker must classify without publishing raw
diagnostics.

The producer's `withCatalogReadScope` callback supplies `selection` and
`recheckSelection()` alongside the existing source/thread rechecks. Its selection
records `basis` (`historical-continuity` or `prospective-import-grant`), an opaque
`revision`, and either explicit `environment-owner` scope or `threads` scope with
exact `threadIds` and `projectIds`. The producer recognizes the physical callback,
checks actual consent/publication and independent sharing, and rejects stale or
revoked selections. The catalog pins that selection for the read and rechecks it
before returning. Client parameters cannot create or widen it.

Thread recipients query only selected journal identities, original shell rows
and expressly permitted projects. They never enumerate the global journal to
discover which IDs to request. Empty published selections return empty original
results and no global counts. Hidden and unknown requested IDs receive the same
denial before an identity lookup. Archive and family use the same selection;
parent/child relationships never widen it. The original trims and count rules run
over the selected rows. Whole-environment owners keep the original full query.
Referenced/inherited content and cross-environment links still need the owning
grant's actual scope and the gateway's independent resource admission; this
source tranche does not certify those integrated authority producers.

Each successful service effect returns `{source: 't3', physicalRootKey,
environmentId, captureGeneration, sourceSequence, selection, value}`. `value` is the original
T3 result, including its unchanged snapshot sequence and cursor. `sourceSequence`
is the captured original high-water; legacy hydration may produce a different
destination sequence. Never substitute either for a broker relay ordinal.
The selection revision also belongs in the dispatcher/cache binding. Reusing a
cursor under changed entitlement requires restarting that selection's snapshot.

## Canonical operations

All reads are finite and mutation-receipt-free. Retry retains the source,
generation and original cursor. A changed generation requires restarting the
snapshot/page sequence. Opaque thread/environment IDs are never normalized,
combined with native IDs, or replaced by titles. Native associations remain links.

| Canonical operation | Original result / behavior |
| --- | --- |
| `orchestration.getArchivedShellSnapshot` | Archived shell snapshot, including projects and original sequence |
| `orchestration.getThreadFamily` | Original active family rows, including idle nested children |
| `orchestration.getOlderSettledThreads` | Original stable cursor, ties, explicit project filter, and limit-zero counts |
| `orchestration.getThreadTitles` | Original titles record for admitted exact IDs |
| `orchestration.getWorktreeThreadIds` | Original worktree rows mapped to original IDs |
| `orchestration.getThreadProjection` | Original bounded compatibility projection |
| `orchestration.getTurnItem` | Original bounded on-demand item/output detail |
| `orchestration.searchThread` | Original per-thread search result |
| HTTP `shellSnapshot` | Original active shell, opt-in idle-child/older-settled trims |
| HTTP `threadSnapshot` | Original wire-projected detail snapshot |
| HTTP `threadTranscript` | Original transcript, original size refusal, exact environment identity |
| HTTP `threadBoundedSnapshot` | Original history window, compact IDs/body flags and cursor |
| HTTP `threadHistoryPage` | Original cursor, through-entry, conversation/work/deferred and compact-ID semantics |

`operations.ts` exports the exact RPC and HTTP descriptors. RPC inputs/results
derive from `ExecutorT3Descriptor`; HTTP inputs derive from the original endpoint
types. HTTP flags remain strings, RPC flags remain booleans. `retainedCatalogSlots`
supplies the eight finite RPC functions to `ExecutorT3ImplementationSlots` and
does not replace the protocol decoder or `requireBoundExecutorT3Operation`.
The dispatcher must preserve the service's capture metadata in its admitted
request context when returning the original inner result.

The parent-integrated runtime dispatcher accepts these finite slots; its runtime
owner composes the held read graph. Original HTTP failures/status retain their request trace. T07's
signed publication transport now has an actual local-reference/ordered-page
producer. Installed source-owner/UOA binding, runtime registration and complete
user journeys still require integrated qualification. No second session-view
wire or generic command tunnel is added.

`subscribeShell`, `subscribeThread`, `subscribeCommandOutput` and
`searchThreadStream` remain explicitly unbound. A frozen capture is not a live
writer/output hub. The runtime/replay owner must provide original streams and
the broker must enforce entry/per-frame/final authority, abort, bounded buffers
and source-sequence resume. MCP/WebMCP need bounded resource handles; collecting
those streams into JSON or returning a single snapshot as a live stream is invalid.
Cross-catalog `searchThreads` remains unbound pending its original search index
and entitled result projection.

## Original grouping and ordering

The service uses the normal `@nessie/t3-session-source/engine` exports:
`ShellStream.loadSubscriberShellSnapshot`, `loadShellSnapshotParts`,
`loadOlderSettledThreadsPage`, `ThreadReadService`, `HistoryPaging`,
`ThreadStream.boundedSnapshotResponseFields` and `WireProjection`.
There is no 5,000-row scanner limit, 30-day cutoff, alternate reducer or local
history cursor. The original newest-25 settled cutoff includes timestamp ties;
older, archived and nested rows retain their original doorways.

`patches/t3-session/catalog/boundary-patches.json` adds optional
`threadIds` adapter inputs to the original `OlderSettledThreadsQuery` and
`ProjectionStore.listActiveShellIndex`. Their SQL predicates run before the
existing cursor/count/LIMIT and index ordering. No-filter behavior,
timestamp ties and SQLite ID ordering stay original. `generate.mjs` reads the
exact pinned Git object and verifies its tree against the source lock; every
edit binds before/after SHA-256 bytes. The family exposes
`ProjectionStore.RETAINED_CATALOG_THREAD_FILTER_VERSION = 1`, which the consumer
requires so an old generated package cannot silently ignore the new predicate.
No RPC input schema gains a caller-controlled authorization filter.

The coordinator/runtime owner must add family `catalog` with
`patches/t3-session/catalog/boundary-patches.json` to the one normal engine
composition and regenerate its manifests/provenance. This tranche supplies that
scoped family but does not rewrite competing shared manifests. Shared shell
reads pass the selected original index and `readShellSnapshot({threadIds})` to
the same `loadSubscriberShellSnapshot` as whole-environment reads. The original
single trim-facts calculation must survive both idle-child and older-settled
trims; independently invoking the two public trimming helpers loses that context.

The actual mobile grouping/sorting helpers are pinned upstream
`apps/mobile/src/features/home/homeThreadList.ts` and its
`packages/client-runtime/src/state/project-grouping` / `thread-sort` imports.
Those client exports are not supplied by this tranche. The client owner must
reuse them; server ordering alone is not evidence of exact rendered mobile order.
Repository enrichment requires the admitted project's enrichment owner and is
not synthesized from a workspace path by passive capture.

## Focused qualification

`test:t3-session-catalog` is a render-free public Turbo gate with the executor
build prerequisite. It uses the normal generated package and disposable original
SQLite engine fixtures. The synthetic physical/owner producers are test-only;
passing them would not qualify a real producer or the installed user journey.

Qualification runs on the coordinator's combined integrated engine graph, after
the serial Maxis window is granted. Do not prepare one dependency tree per worker.
Export the repository-required `DATABASE_URL`, then run on that integrated revision:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=5120'
pnpm exec turbo run build typecheck --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
$env:NODE_OPTIONS = '--max-old-space-size=512'
pnpm exec turbo run test:t3-session-catalog test:t3-session-import --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

The existing importer gate is required because the three retained wrappers now
share the catalog guard. Run scoped lint as well. The authored catalog fixtures
cover 5,007 captured identities with a tombstone, old/tied settlements, archive,
stable settled paging, 360 history rows and repeat cursors, backdated/tied legacy
rows, nested family/orphans, original result codecs and output detail, missing
producers, substituted source IDs, entry/final revocation, unavailable/advanced
generation and cancellation. Shared fixtures also cover noncontiguous selected
IDs, Unicode tie ordering, count-only reads, hidden projects/children, empty
initial publication, denied IDs, changed selection revisions and all four trim
combinations compared with the unfiltered original path. The importer
gate includes the review's exact eight outer-producer/opener regressions plus
current-failure withdrawal, same-generation recovery, alias ABA and obsolete
resume cases. They have not been executed at this source-only checkpoint.
Only bounded builtin syntax/static probes are permitted so far. The follow-up
passed Node syntax checks for 17 changed/new TS/MJS files, JSON parsing,
`git diff --check`, and exact application/type erasure of all six selector patch
edits without executing their module. The final patched `ProjectionStore.ts`
SHA-256 is `8ba0b62967a4ba6a177c1e186d680e52f73f72bd3fa39e99d72c682deeadea50`.
These checks do not resolve imports, typecheck or run engine queries.

The pending manual journey is the entitled user's Dev → computer → T3 catalog,
Archive, Show more, nested family, old exact link, history paging and output
detail, followed by denial/revocation/reconnect through UI, WebMCP and internal
and external MCP. Record the actual integrated revision, environment and capture
generation. No native, provider, browser, live source or production claim follows
from this tranche.
