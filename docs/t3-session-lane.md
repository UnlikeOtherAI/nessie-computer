# Original T3 daemon lane

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

Required integration: the backend finite issuer and T08 admission, current
native association producer, runtime graph adapter and T03C effect receiver.
No installed runtime, human consent, source recognition or provider outcome is
qualified by this source checkpoint. Focused tests and real native/user/tool
journeys remain pending the coordinator's integrated qualification window.
