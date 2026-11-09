# Finite original SQL preclaims

This machine-only boundary admits one conditional lease/attempt UPDATE for the
original `provider-turn.start` row. Its doorway is `Worker.sessionLayer` through
the same original command registry and `makeSessionPreclaimHost`. Production
`open` remains refused until the other real hosts and effect authorities exist.

The service first reads the actual held destination database. It requires the
same accepted Graph and protected parent/initial-message/run/release capture,
and compares original accepted receipts and run events. The preparation includes
all physical row digests, original lineage, source/destination/settings identities,
resource generation and actual custody. This is an enrolled Ed25519 observation
under `nessie.t3.execution.sql-preclaim-preparation.v1`, not permission to update.

Before publishing that observation, the service durably claims the canonical
`nessie.t3.execution.sql-preclaim.slot.v1` identity: executor, accepted source
evidence digest, Graph nonce, effect ID and pre-update attempt count. New row
digests, receipt IDs or nonces cannot renew the same attempt. Failed publication,
expiry and uncertainty leave this first observation consumed permanently.

The existing daemon route handles `execution.preclaim` with only a preparation
receipt. It restores the original relay and operation, takes the existing full
batch prelocks, verifies the enrolled receipt and current source/Graph/custody,
and persists the exact admission payload. Private migration `11006` provides an
immutable Graph/effect/attempt identity with a BIGINT attempt count. Exact
backend retries return the stored bytes and nonce; changed evidence refuses.
The RSA signer accepts only the canonical consumer's opaque admission.

Native consume independently verifies the same-origin RS256 signature and
rereads the actual row, lineage and resource evidence. It requires its live held
preparation and durable first-observation journal. It removes the pending
preparation and durably consumes both the logical identity and backend nonce
before returning a deadline. No SQL mutation occurs in the service.

The total window is at most five seconds from native observation, shortened by
all current parent/source/Graph/relay/issuer bounds. Native retains monotonic
budgets for both the original cap and any shorter backend expiry. Runtime counts
the native consume round trip against the returned remaining budget. The actual
original SQLite connection registers a non-deterministic, direct-only
`nessie_t3_monotonic_now()` function; the conditional UPDATE checks both that
clock and wall time after connection/transaction waits. A wall-clock rollback
cannot refresh the finite transition. Unknown outbox triggers refuse too.

Only the original callback's actual conditional SQL result may reach the worker.
Closing the owner interrupts and joins lineage, HTTP/native work and the SQL
Effect before releasing resources. Reading command scopes cannot consume an
availability wake. Older unsettled effects still block their thread.
Retiring an individual command recorder synchronously aborts its claim host;
registry Scope closure joins that host even if the recorder retired earlier.
The first cleanup rejection remains visible on repeated registry closure.

Preclaim permission grants no provider process, frame, workspace mutation,
secret hydration, startup/import recovery or post-association effect. Expired or
uncertain attempts require supported reconciliation; do not reset or delete the
pending row or journal. That reconciliation and signed installed positive
preclaim execution remain unqualified. Compilation, synthetic crypto/context
fixtures and storage constraints are separate from that installed evidence.

Focused verification uses the public `test:t3-session-runtime`,
`test:t3-session-broker`, `test:t3-session-request-source` and source-engine gates,
the private `test:t3-environment-authority` and broker gates with a migrated
isolated database, and locked common/service/native Cargo tests. Shared Unicode
evidence lives in `test/t3-session-runtime/fixtures/execution-preclaim.json`.

On Maxis/Windows 11 with Node 24.19.0, the combined six-task public build and
13-task backend prerequisite build passed. Focused Turbo suites passed 125
runtime, 27 public broker, 43 environment-authority, 49 backend broker, 13 engine
and 14 privacy cases, with zero skips. Locked Cargo suites passed 70 common,
81 service and 78 native unit plus five Job integration cases, with zero ignored
tests. The native producer's protected installed signing/consume path has not
been exercised positively; these component results do not enable production open.

The final CLI/protocol/management build and typecheck passed six serial tasks;
changed TypeScript and original producer lint passed. Both locked debug binaries
built. A direct package-interface probe outside the test runner left preparation
and expired/stale rows unchanged, performed one low-level conditional lease/attempt
transition and refused replay. Its synthetic databases/evidence remain under
`D:\BuildArtifacts\nessie\t3-7a4698a9-verification\manual-probes`; no native
admission was supplied. The actual unsigned `t3-execution-resource` entry refused
with exit 1. No signed installation, provider or positive installed preclaim ran.

The recorder-retirement follow-up passed the CLI build/typecheck, focused lint
and all 126 runtime cases with zero skips. Its new case holds interrupted cleanup
open and verifies that registry closure waits for that exact retired host.
