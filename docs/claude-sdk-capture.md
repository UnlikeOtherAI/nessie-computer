# Original Claude SDK capture

`@nessie/t3-session-source/claude-sdk` contains the pinned original Claude Agent
SDK `0.3.316` query, encoder and parser behind a private native transport. It is
a machine-only consumer boundary. Production `open` remains refused; the original
T3 Claude runner and an admitted native launch/frame owner are not connected yet.

The SDK package identifies Claude Code as `2.1.316`. Those are distinct versions.
The producer verifies the complete original `sdk.mjs` SHA-256 before applying
AST-bound edits. The original package integrity remains in all three dependency
locks. Its eight optional CLI packages are removed through SDK-scoped overrides;
the capsule requires an explicit executable, cwd and environment. It provides no
default executable, PATH, remote/session-store or custom spawned-process fallback.
Anthropic's source header, README and license remain in the generated output.

## Encoder and queue boundary

`createSessionClaudeQuery(options, owner, parentSignal)` constructs the actual
original query. The original `Iv.initialize` builds the process descriptor; a
private hold intercepts it immediately before either spawn branch. `owner.start`
must asynchronously use the admitted native creator. Its process exposes stdout,
stderr, exit status, input closure, termination and independently observed native
clearance. No generic stdin or synthetic `ChildProcess` is supplied to the SDK.

`capturePrompt(originalMessage)` runs the actual SDK encoder synchronously,
including its `verbatimPrompts` / `client_composed` conversion. Call it before
the original T3 queue offer. The opaque token owns that encoded frame and its
acknowledgment; later mutations of the message cannot change the captured bytes.
Only tokens from this query may enter `streamInput`. Raw messages, foreign tokens
and reuse refuse. Control requests capture before the SDK's initialize callback
queue. Other control writes capture at their original encoder/write boundary.
The one input owner also supplies `interrupt()` for its actual original queue;
closure interrupts and joins a pending take, without abandoning an iterator
behind a promise race. A completed or failed input owner cannot be reopened.

The required `owner.capture` captures original operation context synchronously
and returns a one-use write/discard owner. It is not an authority producer.
Each write still needs independently checked native/backend authority for those
exact bytes and context. In particular, control replies do not acquire effect
or human-answer permission through this interface.

Capture order can differ from SDK write order. A private FIFO serializes actual
SDK write invocations and awaits each owner's native acknowledgment. Limits are
eight retained frames, 256 KiB buffered, 128 KiB per frame and 4095 captures per
owner. Frames must contain exactly one newline-terminated NDJSON record. Released
buffers are wiped and pending acknowledgments reject on closure.

The original process parser reads actual native stdout. Stderr is always drained
and uses streaming UTF8 conversion for the original callback. `close()` aborts and
joins startup, captures, pending writes, parsing and native process clearance;
the first failure is retained. SDK cleanup's own two-second exit wait never
substitutes for that join. A child returned after cancellation is terminated and
joined before closure completes.

## Package and verification

The capsule joins the source package's same unpublished generation before atomic
publication. Its provenance records upstream/patched hashes, exact AST edits,
all authored and declaration inputs, dependency lock, compiler and output hashes.
The ordinary build checks full SDK/peer declarations with TypeScript 5.9.3.

Run `test:t3-session-claude-sdk` on `@nessie/t3-session-source` through Turbo,
with the isolated `DATABASE_URL` exported and concurrency one. Its real Node echo
subprocess exercises the actual SDK query interface, Unicode/client composition,
immutable capture, delayed acknowledgment/order, token rejection and cancelled
startup clearance. The fixture is not Claude, native custody or a provider
success claim. No browser/native UI changes are part of this boundary.

Original T3 query-runner queue integration, original command context, provider
session association timing, post-association effect writes and separately
admitted history read/fork remain required. Full host activation, startup/recovery
authority and installed signed qualification are also unfinished.
