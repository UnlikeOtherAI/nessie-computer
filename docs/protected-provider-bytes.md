# Protected provider byte transport

Source-only continuation, 8 November 2026. No compiler, package test, native
launch or installed journey has qualified this transport. Original SDK
serialization and protected native-association issuance remain unbound.

## Owning interface

`src/coding-session/agent-process.ts` exports
`startAgentByteProcess(context, argv, launchEffect)`. Context omits the injected
process-control port. The creator requires the packaged Windows runtime, the
packaged helper, the machine-host check and a T3 effect carrier. It creates the
ordinary protected process control, awaits its receiver's launch outcome, and
returns `AgentByteProcess` from `agent-byte-transport.ts`. There is no raw spawn
fallback or alternative session engine. Other platforms refuse this producer.
The older line creator and input API reject T3 carriers; they cannot become an
alternate route around the original SDK serializer boundary.

`stdout` and `stderr` are Node Readables carrying the original bytes. Stdout
passes through a 64 KiB Transform that observes provider requests and preserves
normal stream backpressure; stderr stays the original bounded pipe. Byte mode
does not attach readline, consume stderr into a second reader, or stop draining
after the line driver's one-second exit timer. `rawExit` gives code and signal;
`closed` waits for process pipes to close. `exited` retains the independent
`stopped | unknown` clearance result. Callers must drain stderr separately and
await `confirmHostExecutionStopped`, retaining unknown identity debt.
`onError(listener)` subscribes to the actual child error event and returns an
unsubscribe function; the original SDK facade can preserve its error contract.

The synchronous Claude SDK SpawnedProcess facade still belongs to the original
runtime adapter. Its SDK-owned graceful-close signal must not be replaced with
the immediate caller signal. A facade's boolean `kill` result never proves
clearance. This source does not implement or claim a Claude history-worker
entry; fork needs its own admitted finite operation, a fixed immutable executor
entry, and positive child clearance even after its 30-second timeout.

## Input and correlation

`write(bytes, effect): Promise<void>` accepts one complete NDJSON frame as a
Uint8Array or readonly array of byte chunks. Chunk boundaries may split UTF8
characters. `readAgentFrame` copies and assembles the complete frame before
fatal UTF8 decoding. It rejects incomplete frames, multiple frames, duplicate
JSON keys (including escaped/nested keys), non-object JSON and frames above
128 KiB. Decoding and encoding must round-trip every byte; the existing native
string transport therefore preserves accepted input exactly without a new
native wire kind. No callback acknowledges a partial fragment as delivered.

The queue holds at most eight operations and 256 KiB of input. Each finite
frame has a distinct command from the exact same T3/native target; the launch
command cannot authorize input. The carrier consumes after the queue wait, and
the existing receiver challenges it again at send. Up to 4095 post-launch
command IDs are remembered; exhaustion refuses rather than forgetting replay
history. This limit is an explicit unfinished long-session constraint, not a
claim of original session parity. Failed/uncertain dispatch permanently closes
the lane. A late ACK cannot revive it or permit a retry. ACK means receiver
delivery, never provider acceptance or completion.

This API does **not** manufacture the missing original-operation-to-protocol-ID
binding. The reviewed serialization owner must capture that association with
the frame before queuing it. Codex's pinned `protocol.ts` boundary is before
`Queue.offer(outgoing, encoded)`. Claude SDK0.3.316 queues user input and creates
control IDs internally; public `query` does not expose its Transport. A narrow
reviewed serializer hook is required. AsyncLocalStorage around query calls,
private Query monkey patches, a current-grant field and an SDK Writable callback
cannot establish this association.

Consequently `stdin: Writable` rejects every generic SDK write with
`AgentSerializationAuthorityRequired`. Its final callback awaits protected EOF;
it never acknowledges arbitrary SDK bytes using launch authority. The explicit
frame API is not wired to the original SDK until that missing producer exists.

`replyUnsupported(id)` is the only automatic reply entry. A bounded stdout
ledger must have observed that exact outstanding provider request. It generates
only a fixed unsupported/error response, never caller JSON, tool output or an
approval. The ID is consumed before dispatch; numeric and string IDs differ,
Claude cancellation withdraws an outstanding ID, and finite replies also
consume the matching entry. Duplicate requests, malformed/oversized output or
more than 256 outstanding IDs close automatic correlation without truncating
stdout. Automatic entries expire after 30 monotonic seconds. Such output still
reaches the original parser; no output limit substitutes for original history.

## Authority and tool surfaces

This is a machine-only transport below the existing original T3 operation.
There is no new MCP/WebMCP action or tool-registration bypass. Canonical input
remains the admitted ExecutorT3Request with exact environment/thread/provider
session, command/correlation IDs, signed offer digest and native association.
The per-frame result is finite acknowledged/failed transport delivery; output
is a backpressured stream. Owning operation receipts and uncertain retry rules
remain with the original broker. All three tool surfaces must use that same
operation, never call this process creator directly.

The finite carrier remains
`requestT3EffectAuthority(directory, VerifiedT3EffectGrant, signal?)`. Current
protected directory enrollment must match the grant issuer. Raw selections,
alias rows, credential namespaces, native IDs and caller callbacks grant
nothing. The private native admission still denies: process custody alone
does not establish an original native association.

## Qualification

`test/agent-byte-transport.test.ts` is registered in the existing
`test:executor-private-assignments` public Turbo gate. Authored fixtures cover
UTF8 splits, ambiguous frames, exact request IDs, cancelled/consumed replies,
generic SDK refusal, launch-grant reuse, byte output, delayed ACK, exit before
ACK, late ACK and queue overflow. Synthetic receiver ACKs test transport only;
they are not signed native launch or association evidence. All remain unrun.

Run the existing bounded custody gate only in the coordinator's serial window,
with this checkout's own dependencies, at least 12 GiB free on Maxis, concurrency
one, a test heap of 512 MiB and compiler heap at most 5120 MiB. The actual signed
synthetic route/launch/input/revocation/crash journey additionally requires the
reviewed serializer hook, protected association issuer and compatible signed
release manifest/service/managed parent. Never downgrade the installed e799a7
service or use a personal provider as the fixture.
