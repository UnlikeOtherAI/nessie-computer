# Retained T3 catalog read composition

This source tranche composes the qualified retained capture with the original
engine's catalog and history reads. It does not establish a running transport,
physical-source admission, original-human continuity, selected-team publication,
live writer, mobile parity or a completed user capability.

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
caller assertions. The real physical and original-human producers remain
required. No adapter in this tranche constructs authority from IDs, paths,
timestamps, callbacks or managed-start receipts.

Every read checks physical identity and original-owner authority at entry and
before return. The local journal must be available, nonconflicting, ready and
published at the requested generation. It rechecks publication after source and
owner callbacks finish. Refresh, revocation, replacement or abort rejects the
result; it never returns an authorized prefix or an empty success. Effect
cancellation reaches the original engine query and the surrounding lease checks.
Original typed query failures remain failures; lease and workspace failures are
transport defects, which the outer broker must classify without publishing raw
diagnostics.

Catalog reads currently require the original-human lease to authorize **every
nondeleted retained identity**. This is deliberately incomplete for a viewer with
access to only part of a source: the current continuity interface can deny a
thread, but cannot select entitled rows or projects. A canonical selected-team
row/project projection input is still required. Catching a rejection and dropping
that row would hide outages/revocation and is not a valid implementation.
Thread-specific reads retain their existing exact-thread authority behavior.
Cross-environment linked resources still require independent gateway admission.

Each successful service effect returns `{source: 't3', physicalRootKey,
environmentId, captureGeneration, sourceSequence, value}`. `value` is the original
T3 result, including its unchanged snapshot sequence and cursor. `sourceSequence`
is the captured original high-water; legacy hydration may produce a different
destination sequence. Never substitute either for a broker relay ordinal.

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

There is no T3 daemon transport dispatcher at this base revision. Registering
these slots in the eventual dispatcher, mapping HTTP failures/status with its
request trace, and binding the canonical server publication are integration
dependencies. No second session-view wire or generic command tunnel is added.

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

After the coordinator grants the serial Maxis window, prepare only this
worktree's frozen dependencies, export the repository-required `DATABASE_URL`,
then run:

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
generation and cancellation. They have not been executed at this source-only
checkpoint. Only bounded builtin syntax/static probes are permitted so far.

The pending manual journey is the entitled user's Dev → computer → T3 catalog,
Archive, Show more, nested family, old exact link, history paging and output
detail, followed by denial/revocation/reconnect through UI, WebMCP and internal
and external MCP. Record the actual integrated revision, environment and capture
generation. No native, provider, browser, live source or production claim follows
from this tranche.
