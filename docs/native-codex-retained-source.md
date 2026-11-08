# Native Codex retained source

The Codex adapter in `src/t3-session/native-sources/codex` supplies passive data
readers for the shared three-source catalog. It does not advertise a capability
or establish admission. Native physical-resource and original-human read
producers, catalog publication and tool registrations are still unbound.
No installed source or personal history was accessed to author these readers.

The existing `ExistingCodex` driver remains the recent discovery and experimental
queue path. Its app-server transport, 30-day/5,000-session discovery and bounded
transcript tail are not a complete retained source. The new readers do not call
that transport, start a provider, resume a thread, access authentication files,
write a database or deliver input. Native Codex remains a source independently
of a T3 thread's selected provider.

## Identity and inventory

`CodexNativeIdentity` retains the exact executor, admitted continuation-home key,
history-home key and native ID. Keys encode the tuple without UUID substitution,
path normalization, title matching or account-overlay ownership inference.
Canonical resource admission must supply home equivalence; these strings are
data, not bearer authority. An overlay with a different history home stays a
different native identity. An overlay sharing both proven homes can add a history
resource reference to the same native row.

`readCodexIndexPage` reads the native `threads` table through an already held
readonly transaction. It selects only ID, title, timestamps, archive flag and
the internal rollout lookup hint. It validates the actual table and required
columns, uses native updated-time/ID order with a strict keyset cursor and has
no age or total-row cutoff. Empty/state-only threads and archives are included.
The rollout path is internal; it must never become a tool argument, wire result
or authorization decision. Resolve it through the held resource owner.

An index page cannot certify full native inventory. `CodexRetainedCatalog`
requires completed enumeration of the state index, `sessions` and
`archived_sessions` at one watermark. The shared source owner must produce
these pages, including old unindexed rollouts, or leave the source incomplete.
There is no home-directory crawl or implicit default-home discovery here.
Missing/unsupported stores do not count as empty stores. Page order and cursors
are checked; cycles, capacity exhaustion and interrupted scans cannot publish
completion. The default 100,000-row safety bound fails explicitly rather than
dropping later entries. Every returned page is bounded to at most 256 rows and
an explicit payload byte budget (512 KiB by default).

State-index metadata takes precedence over directory observations during archive
moves. Exact resource references survive deduplication. Explicit tombstones are
retained and cannot revive inside a capture; absence never creates a tombstone.
Durable cross-generation tombstones remain the canonical index owner's job.
Incomplete recapture must retain the previous index subject to fresh access.

`codexAssociationCandidates` returns every exact admitted T3 association,
including deleted owners, and reports ambiguous control for multiple app
identities. It never merges app histories, changes a T3 environment/thread ID,
grants access to a linked row or chooses a writer. UI/tool callers must authorize
each target separately and exclude unauthorized/deleted rows from display.

## History and privacy

`CodexRetainedHistory` consumes a held byte-range resource. The shared native
history port must establish original-human continuity, physical resource
identity, immutable prefix length, replacement fencing and current read
revocation before constructing this data-plane view. Its `recheck` function is
not an admission factory; fixture callbacks supply no production proof.
Keep the instance inside the canonical port's live callback and invalidate it
when that lease ends. Reads must honor the canonical maximum 60-second freshness.

Preparation walks every complete JSONL record in 64 KiB reads before any page
is published, then validates a full projection pass using that correlation.
The first `session_meta` must bind the exact native ID; conflicting
headers fail. A record is limited to 1 MiB, with no tail or message-count
retention cutoff. Malformed JSON/UTF-8 and oversized records fail explicitly.
A partial last record yields `partial-final-record`, and a later source capture
must prepare afresh. Cursors bind the exact source, resource revision, captured
length and record boundary; byte position never substitutes for native item IDs
or T3 sequence numbers. Each page rechecks before reads and publication.

Pages preserve native record types, payload IDs and source order. They expose
messages, supported reasoning summaries, tool calls/results, context and
compaction/lifecycle markers. Unknown variants retain an explicit unsupported
slot and make completeness `unsupported-records`; they are not silently
discarded as complete history. Token-count events are explicitly excluded;
encrypted reasoning and generated image bytes are not exposed. The latter
need the admitted asset resource lane.

Secret-tool classification uses the real pinned
`@nessie/t3-session-source/engine` `RequestPrivacy` export. Full preflight
correlates native call IDs before any output is returned, including an output
stored before its call. It does not retain secret values. Correlation exhaustion
fails closed. Native `request_user_input` descriptors retain their original IDs,
questions and option labels. Missing historical masks withhold initial/option
values and the correlated answer; explicit private values are redacted.
Unbound tool outputs are marked withheld. Conflicting duplicate question masks
fail. Unstructured prose echoes without provenance are outside this structural
guarantee. These are read projections, never restored response callbacks.

## Canonical operations for UI, WebMCP and MCP owners

All operations below are finite. None grants control or performs a mutation.
The tool owners should register their existing admitted catalog/history facade,
not expose an alternate filesystem/RPC endpoint or accept these internal objects
from an external caller.

| Operation | Input and result | Grants and retries |
| --- | --- | --- |
| `CodexRetainedCatalog.page` | Held source capture; bounded limit and opaque source/watermark cursor → native rows, watermark, next cursor and completion | Fresh selected-team native-source read plus original-human continuity. Tombstones/aliases require independent display filtering. Same capture/cursor replays the same data; a changed capture rejects the cursor. No command receipt. |
| `CodexRetainedHistory.page` | Exact admitted native/history resource; prepared capture, bounded limit/bytes and cursor → ordered native records, omissions, watermark, cursor and explicit completeness | Fresh per-native-history read before bytes and before publication. Revocation/replacement fails; no cached authority. Retry at the same capture/cursor; restart from a new capture after a stale cursor. No command receipt or stream. |
| `codexAssociationCandidates` | Exact native identity and canonically admitted association candidates → all matching original T3 identities and ambiguity | Each linked app identity needs its own current read grant. Relationship data never renews execution custody. Pure finite lookup, no receipt. |

`readCodexIndexPage` and capture `append`/`seal` are internal preparation steps,
not additional user-facing tools. Cancellation aborts the read and discards
unpublished data; it never stops native work. Transport correlation IDs remain
separate from cursors and native identities. No raw provider credentials or
secret input enter these operations.

## Verification

After an authorized serial qualification window and frozen dependencies, run:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=512'
$env:TURBO_CONCURRENCY = '1'
pnpm exec turbo run //#test:t3-native-codex --root-turbo-json=scripts/turbo.public.json --concurrency=1
```

The gate declares the normal executor build and engine dependencies. The
existing compiler wrapper caps its heap at 5 GiB. No PostgreSQL, provider,
browser or native app is needed for these fixtures. They use synthetic SQLite
and held bytes, not asserted production ownership.

At authoring, builtin TypeScript syntax parsing passed; build, lint and the
functional gate remain unrun under the source-only allocation. The full
ordinary-client journey through Dev, WebMCP and internal/external MCP is pending
the shared resource/owner producers and catalog/gateway integration. No full
native inventory, protected host or manual user-flow qualification is claimed.
