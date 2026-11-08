# Historical question privacy

Status: synthetically qualified on Maxis with owned Node 22.23.1 and pnpm
10.22.0. Code/test revision `e6807fca397168348b630dea27b0e2d60b81dbf7` passed
normal build/typecheck, 15 source cases and 32 original-engine importer cases,
with zero failures/skips. No physical source, original-human authority, gateway
or UI is enabled; this is not live retained-session admission or full fidelity.

## What the pinned source retains

The evidence is original T3 `25bf84ab07f53f141c20239c63e383823a9d5ea0`:

- `packages/contracts/src/orchestrationV2.ts:1340`: the question codec has IDs,
  header, question, ordered options and `initialAnswer`, but no `isSecret`.
  `:1216` defines runtime answers without classification. ProjectionStore's
  `encodeRuntimeRequestPayload` and `encodeTurnItemPayload` use those codecs.
- `Adapters/CodexAdapterV2.ts:4322` constructs a new question object without
  the native mask; `:5231` maps asynchronous questions to the same shape.
  The marker can disappear before persistence, not just on later decoding.
- `Adapters/ClaudeAdapterV2.ts:7796` copies questions into the question item;
  `:10396` also hands questions and answers back through SDK tool input.
  The request and tool share native references, independently of question text.
- `packages/contracts/src/providerPolicy.ts:90` defines embedded answers,
  `questionTextById` and attachment arrays. `Orchestrator.ts:9545` persists these
  copies; `:9602` derives `async-answer:${requestId}` for message-mode answers.
- `chatAttachment.ts:148` and `:161` admit image/file references with required
  IDs, names, MIME strings and sizes, plus optional snapshot/pasted sources.
  `composerContext.ts:94` repeats descriptor metadata under `attachmentId`.
- The legacy importer reads messages, context and attachment references. It
  does not recover a question classification from legacy transcript text.

No inspected admitted field supplies authoritative classification after these
losses. Native credentials, provider transcript files, current login, titles and
question wording are not classification sources. No external credential or
provider transcript store is opened.

## Projection contract

Capture retains the entire catalog and session graph, IDs, timestamps, statuses,
request/question/option ordering and attachment-reference ordering. It uses the
original codecs before accepting the final representation. It adds no schema
field, alternative session DTO or inferred `isSecret: false`.

An exact source-thread/request/question key has three states:

| Evidence in the pinned transaction | Stored values |
| --- | --- |
| Explicit `false`, with no conflicting occurrence | Original question and answer values, including their original shapes |
| Explicit `true`, with no conflicting occurrence | Existing `[REDACTED]` semantics for defaults, option values/previews and answers |
| All occurrences lack classification | `[WITHHELD:UNKNOWN_QUESTION_PRIVACY]` in initial answers, option values/previews and response values |

The unknown sentinel is a machine representation of withheld data, not a claim
that the value was secret or that the user supplied this text. Original answer
arrays retain element count/order; opaque non-array answers become one sentinel.
Question IDs, answer-map keys, header/question text, titles and ordinary option
labels/descriptions remain exact under the existing permitted-descriptor
contract. Original Claude constructs the question ID from the question text
(`ClaudeAdapterV2.ts:4625`); its answer-map keys repeat that text. The parent
confirmed that these descriptors must remain visible and must not be renamed,
cosmetically redacted or refused merely because the ID equals question text.
There is no concealment guarantee for text already embedded in identifiers.
This is value-payload privacy, not whole-message confidentiality or a claim that
identifiers have been semantically proved secret-free.

`questionTextById` remains the exact descriptor copy. Response feedback bound
to a question request uses its request classification. Value-bearing fields
cannot escape masking by being treated as descriptors.
The unknown marker does not change live question admission or canonical saving.

Masks are collected before original decoding, across all rows and events, so
answers may precede requests. An explicit marker can cover only an exact matching
occurrence. Conflicting masks, malformed markers, answers without a declared
question, embedded request disagreement and SQL/payload identity disagreement
still fail before destination session inserts. Duplicate IDs within a question
array retain their positions when their mask states agree (including all
unknown). A partial mask on one duplicate or changed multiplicity across
occurrences refuses: the original answer map carries no ordinal to disambiguate. No session is silently skipped.

Message-mode answer text is correlated only through an observed request and the
original deterministic message ID, in the same thread. Dynamic-tool copies bind
the source thread, provider thread, provider turn, driver and native item ID.
Conflicting request bindings refuse. An original Claude `AskUserQuestion` tool
without that complete binding withholds its own opaque values as unknown; it
cannot borrow another request's public classification. Their opaque input/output/path fields
are withheld as a unit when any question is private/unknown; these opaque copies
do not supply reliable per-question subfield identities. The typed question and
answer records still retain independently known public fields exactly. Optional
context on a correlated answer message is removed rather than reinterpreted.

Attachment IDs, file/image types, sizes and array positions survive. Names become
the applicable sentinel, MIME values become `image/x-withheld` or
`application/x-withheld`, and optional source/preview metadata is removed.
Repeated descriptor and composer-context references in the same thread receive
the same projection, including legacy message descriptors. An attachment reused
by both a public and private/unknown question is a classification conflict,
not permission to disclose or silently alter a known-public answer. No attachment
bytes are opened, copied or made deliverable by retaining an ID. The resource
owner must still authorize any future byte access independently.

All correlation retains IDs/classification only, bounded by 8,192 entries per
index, a shared 256 KiB encoded-identity budget, bounded individual keys and the
existing row/depth/member limits. Exhaustion refuses; it never evicts evidence.
Each capture gets new classification; fingerprints, publication/currentness
fences, complete catalog ordering and frozen-legacy rules are unchanged.

## Remaining boundaries and comparator rules

This representation cannot reconstruct erased classification or original values
from withheld output. It is not full-fidelity history. A real-machine comparator
must compare every session identity, graph edge and ordered item first, then
allow only these documented field-level differences under this exact projector
revision. Unknown is not equivalent to public or known-secret. Do not ignore an
entire session, accept a subset, or treat a successful capture as source authority.

An arbitrary message, summary, code string or unknown tool payload may contain a
human-pasted or provider-echoed value without a structural request reference.
The original schemas do not carry enough provenance to identify that occurrence
without interpreting prose or blanket-redacting ordinary history. This projector
does neither. It does not claim to sanitize original/native stores or arbitrary
uncorrelated prose. A correlated tool without the complete native tuple cannot
borrow a different request's classification. Broader source acceptance requires
producer evidence or a separately specified representation for such data.

The registered `test:t3-session-import` task includes original-codec-normalized
questions, destination SQLite/raw bytes, original replay/export/cache reads,
resume/refresh, and scoped message/tool/attachment copies. The source gate adds
metadata, repeated-ID, conflict and bounded-correlation cases. All 15 source and 32 original-engine cases passed in the subsequent PRIMARY
window below. Parser checks alone do not qualify privacy.

## Qualification attempt and resource release

The owned frozen public install passed on Maxis with official Node 22.23.1 and
pnpm 10.22.0. Before the first build/typecheck, the guard measured 6.8536 GiB
free at 2026-11-08T11:20:43Z, below the required 12 GiB floor. It refused before
Turbo/compiler launch. PRIMARY was released immediately to the coordinator;
there were no further heavy starts or memory polls. Producer preparation,
normal build/typecheck and both registered runtime/source gates remain unrun.
Bounded parser checks now cover three TypeScript and five fixture modules;
these are syntax evidence only. Preserve the owned worktree and failure logs.

## Completed synthetic qualification

After a new explicit PRIMARY handoff, normal frozen producer preparation and
build/typecheck passed all 11 tasks, with zero cache hits in that build. The
registered source gate passed 15/15 cases; the original-engine importer gate
passed 32/32, zero failures/skips, against that owned build. It reused five
unchanged build prerequisites through this worktree's local Turbo cache and ran
both preparation and the test task. No code or fixture repair was needed.

The first retry failed before Turbo because Windows backslashes in the local
NODE_OPTIONS preload path were consumed. Changing that untracked runner path to
forward slashes fixed invocation; the failure is preserved. No compiler option,
diagnostic, schema or test was bypassed. Each job checked >=12 GiB free; compiler
entry guards recorded a minimum 16.57 GiB. Tests used 512 MiB heaps, compilers
5120 MiB and concurrency one. The private receipt binds exact commands, inputs,
built output hashes and logs. The earlier memory refusal remains historical.

The original supported capture/read interfaces exercised actual SQLite stores,
legacy hydration, replay, cached reads, bounded exports, resume/refresh,
complete catalog/item ordering, permitted Claude descriptors/textual IDs, value
canary absence and provenance refusals. Currentness/fingerprint/frozen-legacy
regressions also passed. This did not read personal histories, bind physical or
human authority, run providers, install native apps or qualify a gateway.

The terminal importer result ended at 2026-11-08T11:52:28Z. PRIMARY was released
immediately before hash/documentation closure; no further heavy jobs ran.
