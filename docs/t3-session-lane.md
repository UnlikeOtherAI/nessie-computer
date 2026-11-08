# Original T3 daemon lane

## Cold inspection and accepted graph retention

`describeInspections()` announces actual held source/writer descriptors with
`role:'source-inspection'`, environment, runtime generation, pinned source
revision, physical root and capture generation. It is separate from `describe()`
and retained `state:'ready'`. The daemon never infers inspection availability
from read readiness or mere presence of `inspect`. Backend registries are
separate; original reads cannot select a cold inspection-only graph.

The runtime lifecycle is `inspect(request,signal,{inspection,relayHmac,
retentionExpiresAt})`, `acceptInspection(request,accepted,signal)` and
`releaseInspection(inspectionId)`. The last method joins actual held-scope
cleanup after abort. All three accompany inspection discovery. These methods
and descriptors convey resource demand, never authorization or effect signing.

The signed challenge's five seconds limit first evidence acceptance. The offer's
`retentionExpiresAt` comes from the original opaque operation deadline and is
only a pending resource cap. A lost response can retry the same receipt within
that cap; no receipt or challenge is renewed. The cap also reaches the protected
child so a stalled daemon pipe cannot retain its resources indefinitely.

`inspectionAcknowledged` now contains strict `T3LaneInspectionAccepted` objects.
Each carries the canonical backend `graphId/expiresAt`, full receipt digest
(`sha256(canonicalExecutorJson(receipt))`), original request SHA/relay HMAC,
inspection/command/correlation and exact executor/environment/epoch/runtime/
source identity. The pump compares these to its held job. Acceptance only
shortens retention to the exact backend parent deadline. Exact duplicate ACKs
do nothing; changed metadata or extended deadlines refuse.

An accepted ACK drops the receipt job without aborting its graph parent signal.
Expiry, source descriptor withdrawal, connection loss or lane close aborts and
joins `releaseInspection`; capacity remains occupied until cleanup completes.
The same held graph must still consume the independent signed original
reserve/launch/open authority. Acceptance is never a ready announcement.

Transport fixtures cover late ACK after the five-second signature window,
same-signal retention, immutable replay, digest/source/runtime substitution,
descriptor withdrawal and joined release. They are authored, unrun in
SOURCE/TINY; native and original-engine qualification remains with integration.

Status: authored source, not runtime-qualified. The owning daemon registers
`createT3SessionLane` through `serveExecutor(..., { t3Sessions })`. The admitted
runtime supplies that port from its single held graph; absence leaves T3
dispatch unbound. Native session views keep their own DTOs.

`exchangeT3SessionOperations` uses the existing API client, machine signature,
connection epoch and session wake cadence. It carries original RPC and HTTP
envelopes. There are at most 64 active demands, eight frames per exchange,
one response credit per demand, 8 MiB per frame and 32 MiB buffered replies.
Offers and credit/hold controls carry a finite 60-second lease. Lost HTTP
answers retain exact pending frames. Cancellation/expiry closes demand and
does not assert that a provider turn stopped. Durable command outcome remains
the original engine's receipt.

`T3SessionLaneRuntime.open` must reconsume canonical operation authority and
native custody before effects. It must use the original operation slots and
Effect scope, not construct another engine. No source import grant permits
control or `vcs.listRefs` with `refresh: true`.

`createT3EffectAuthorityClient(() => enrolledState)` issues and refreshes a
five-second `VerifiedT3EffectGrant`. A grant binds exact original command,
request HMAC, executor/environment/thread/provider session, epoch/runtime
generation and native association. The client verifies an RS256 signature
against the existing JWKS on the enrolled HTTPS origin, along with its fresh
nonce and proof digest. It accepts no signing key from the grant. Serialization
loses the in-process brand; restoration needs a fresh round trip. A native
receiver must compare `issuerOrigin` with its protected enrolled backend and
the entire immutable native target before accepting the grant. Constructor
access and a copied JSON object cannot forge the brand.

`VerifiedT3EffectGrant.signedProof: T3EffectAuthorityChecked` returns a frozen
copy of the exact verified `{grant,keyId,signature}` envelope for the protected
native receiver's independent signature check. The private issuance token and
WeakSet remain the only producer; the accessor refuses expired grants and a
serialized envelope cannot be promoted. `consume()` performs a fresh checked
exchange and its returned grant carries that new nonce and signature. This
accessor does not authorize pre-native-ID bootstrap or bind provider stdin bytes;
those require the separate execution frame admission and actual serializer.

Required integration: the backend finite issuer and T08 admission, current
native association producer, runtime graph adapter and T03C effect receiver.
No installed runtime, human consent, source recognition or provider outcome is
qualified by this source checkpoint. Focused tests and real native/user/tool
journeys remain pending the coordinator's integrated qualification window.

`open(request, signal, { requestDigest, provenance? })` receives the broker's HMAC separately
from the original envelope. `describe()` reports only actual held runtime/source
incarnations; the lane signs those reports. A raw request, captured database UUID
or process-local random value cannot invent a ready runtime descriptor.

`ExecutorT3LaneDelivery.provenance` is the original
`Threads.ThreadManagementProvenance`, decoded with the original actor/source
schemas. Authenticated ingress supplies prospective user/agent and web/MCP
origin; it cannot come from original command payload fields. Active-offer replay
must preserve both digest and provenance. The request digest remains the original
request HMAC; the private first-command fingerprint additionally binds captured
initiation. Runtime control slots require admitted provenance. Neither this
metadata nor a read/import grant authorizes native launch; the verified native
association producer remains a separate prerequisite.

The shared `requestTargets` accepts the original correlated method/input union
before routing is attached. Tool ingress can therefore admit every decoded
target before resolving the signed lane, without inventing an epoch or runtime
generation. An optional original source-thread hint still has to match a target;
it never replaces the full target set.

`createT3CatalogPublicationTransport` sends bounded metadata pages and completion
through the same paired API client and `t3_catalog` signature domain. It checks
receipts and epoch changes. It does not enumerate a local source: the concrete
ordered held-capture producer must still bind `T3CatalogPublicationPort`. No
filesystem reference is dereferenced by the backend and no UUID sort is supplied
as an alternative to original source order.

Authored, unrun unit fixtures cover exact signed-frame retries, credit gating,
epoch cancellation, actual grant signature verification, changed targets and
JSON/constructor forgery. After integration, run `pnpm exec turbo run
test:t3-session-broker --root-turbo-json=scripts/turbo.public.json --concurrency=1`.
This normal build-dependent gate needs the coordinator's serial qualification
window; builtin syntax checks do not qualify it.
