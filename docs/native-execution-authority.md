# Protected execution issuer

The native execution issuer, finite phase receiver and public companion client
are source-authored and unqualified. The isolation gate deliberately refuses the
current same-user managed-runtime creator. No signed launch or association has
been demonstrated.

`packages/protocol/src/t3-session/native-execution.ts` defines the distinct
execution domains and strict schemas. Signatures cover UTF8(domain + newline +
exact payload string). Backend admissions use RS256 and the protected paired
origin's JWKS; native receipts use a separate service-owned Ed25519 key, SPKI
base64 public key and SHA256 SPKI key ID. Receipt signatures are base64url.
Keys carried in receipts never establish trust.

The descriptor includes independently observed service/controller/supervisor/
runtime generations, installed release digest, service image digest and Job.
Its self-signature proves possession only. Enrollment stays pending until the
exact descriptor/challenge has both protected local owner approval and the
backend's explicit canonical UOA owner verification. The challenge binds the
enrollment/executor IDs, paired origin, descriptor digest, nonce and deadline.
No retained-import key or signing domain is reused.

Reservation has no native ID or provider-session ID. Its binding contains opaque
SHA256 actor/initiation references, both original request SHA256 and relay HMAC,
and a sourceEvidenceDigest. That evidence must come from an actual held source
graph admission before reservation; the reserve DTO cannot create it. Original
references stay in the backend relay. Launch adds its exact launch digest;
association adds the original provider-session ID and service-observed native
identity. An observed native ID never substitutes for an original session ID.

Graph receipts have domain `nessie.t3.execution.graph.v1`, include every
resolved original request target and source revision, and have no launch digest.
Only after original admitted provisioning produces the actual native process
descriptor does `T3ExecutionPreparationPayloadSchema` bind its exact digest,
reservation ID, actual original providerSessionId allocated before spawn,
original reserve admission digest/binding and custody under
`nessie.t3.execution.preparation.v1`. Backend launch admission must consume this
receipt rather than accepting a raw caller launch digest. Descriptor/reference
digests use canonicalExecutorJson; admissionDigest hashes the exact signed
payload string bytes without domain or reserialization.

`test/t3-native-execution-contract.test.ts` authors byte-level U+000A and Windows
single-separator checks plus five-second admission lifetime/phase refusals.
These fixtures are unrun. Source inspection confirms the original helper has
one escaped newline and regex one escaped Windows separator, not literal
backslash+n or a doubled path separator.

The source graph producer and original SDK serializer remain separate owned
dependencies. Generic SDK stdin remains denied. No signing, install, native
launch or heavy check is authorized in this checkout's source window.

## Implemented source and machine interface

`windows-common/src/execution.rs` owns the strict native wire. A separate
`nessie.t3.execution.inspection.v1` backend signature binds the original target
ledger (including an empty ledger), source revision, opaque actor/initiation
digests, SHA256 and relay HMAC before graph inspection. Native validates the
paired HTTPS origin's RS256 JWKS, exact payload bytes and five-second lifetime.

`service-windows/src/execution_context.rs::authenticate_graph` is the shared
resource receiver gate. It checks actual pipe peer/parent, registered
T3SessionGraph generation, supervisor, Job, pairing owner, immutable release,
service image and execution isolation. `DescriptorContext` exposes only
`paired_origin` and actual `custody`. Enrollment and all later receipts require
the same full custody tuple; a different graph is not a compatible replacement.

`execution_key.rs` owns a distinct Ed25519 seed under the existing service-only
root. Append-only CREATE_NEW journal claims precede proof/effect delivery;
uncertain delivery is never retried. `execution.rs` implements reserve,
preparation, launch and association. Accepted reserve expiry bounds acceptance,
not later evidence preparation. Preparation grants no effect; it carries a
fresh five-second deadline and the original accepted reserve payload digest.
Launch always needs a fresh current backend admission. The service retains the
actual process descriptor and executable handle in `execution_preparation.rs`;
restarting the service cannot recreate that hold from a journal.

The graph record links SHA256(exact GRAPH payload UTF8) to the live resourceId.
The physical-source owner's `execution_resource::bind_graph` rechecks held
source/settings/home evidence before graph signing and every phase. This is an
integration dependency, not a callback or a default-success implementation.

`native/src/t3_execution.rs` accepts only `t3-execution` followed by `offer`,
`enroll`, `graph`, `reserve`, `prepare`, `launch` or `associate`. Each finite mode
reads one bounded JSON line and returns one JSON result. No public `approve`,
`observe`, generic signer or stdin mode exists. Enrollment uses the shared
secure-desktop current Windows owner authentication; the dialog displays exact
challenge/key/release/parent data, with six language translations. This local
proof never replaces backend canonical UOA owner approval. Moving that OS-only
primitive out of retained consent does not share retained keys or domains.

Launch receives the exact descriptor plus signed finite admission, starts
suspended, attaches a kill-on-close Job and service-held stdout reader, then
resumes. Loss of parent or service terminates the Job. Existing independent
HostRelease must positively clear every child; failure preserves debt. Stdout
forwarding is lossless and blocks on downstream backpressure. Association reads
only actual child output; requestId is the provider RPC response ID (Codex) or
system/init UUID (Claude), never inferred equal to backend correlationId.
Generic provider stdin remains unimplemented and denied pending original SDK
serialization correlation; this native source does not qualify provider use.

`src/t3-execution-native-client.ts::createT3ExecutionNativeClient` exposes finite
offer/enroll/graph/reserve/prepare/associate transport through the fixed packaged
helper, bounded output, cancellation and no retry. Signature verification is
consistency evidence only; it cannot enroll a caller-selected key or mint a
SessionEffectAuthority. Backend intake accepts only its enrolled key. Native
start/bytes stay underneath the original adapter, never a separate tool path.
UI, WebMCP and internal/external MCP registration remain with their respective
owners and must use the same original admitted operation.

## Isolation defect and remaining acceptance

The existing `managed_windows.rs` uses std::Command and changes inspection
permissions after CreateProcess. Signed image, generation and Job do not stop
same-user injection or token/handle duplication. The new execution gate requires
recorded SYSTEM creation plus process/thread/token/default-DACL and mitigation
checks from `execution_isolation.rs`, before registration and on every call.
Current same-user startup cannot pass. This refusal is intentional.

The missing production creator must establish protected process/thread/token
security at creation for the graph AND each native companion, before their first
instruction, and preserve original runtime transport. Tightening ACLs after
spawn, a boolean marker or merely a signed helper does not establish that fact.
The existing retained SYSTEM launch has OS primitives to refactor, but its
signer, key and domain must not become the execution issuer. Installed Node and
all required native modules must also pass the mitigation compatibility journey.

Physical resource modules and original allocator/serializer integration need
parent integration. New service Cargo dependencies need root-owned lock
resolution. Rust formatting/parsing, Node syntax-only checks and git diff checks
ran; no Rust compiler, typecheck, suite, signing, install or native launch ran.
Authored fixtures cover phase/expiry, strict prospective fields, SHA/HMAC/domain
separation, signature mutation, exact original targets and forbidden native
approval/handle commands. Root's serial window must compile these sources and
exercise enrollment, denied ordinary-process injection, expiry/revoke/late
delivery, exact provider association, backpressure, crash and positive clearance
through the signed disposable installed journey. No production-working claim.
# Protected creator source checkpoint

The fixed SYSTEM creator is under implementation. Its service journal records
the actual creator, graph and companion process generations before resume.
Creation installs process, thread and token ACLs, mitigation policy and Job
membership before the child's first instruction. The startup descriptor goes
directly to graph stdin; its per-graph channel key never reaches the daemon.
Companion transport acknowledges stdin only after the child pipe write and
requires independent service clearance of the Job before reporting closed.

This checkpoint is not wired or qualified as an installed capability. Listener
registration, public stream consumption and lifecycle review remain in progress.
No compiler, native launch, signing or installation was run for this checkpoint.

# Nonexecuting inspection delivery

The canonical daemon session lane carries bounded `inspections` and exact
`inspectionReceipts`, with explicit acknowledgements. Only an executing runtime
implements `T3SessionLaneRuntime.inspect`; retained runtimes omit it. Inspection
and `open` must reach the same held, native-registered graph process. Inspection
never calls `open` or allocates a provider session, and its fixed deadline joins
source finalizers before the slot is released.

The backend separately admits the original command after an enrolled graph
receipt. Its normal offer carries `executionGraph` with the unchanged original
request/HMAC/provenance. The service receipt freshness window bounds acceptance;
the command's current parent authority and relay expiry bound subsequent use.
Graph evidence is not a native launch grant. Each native effect still consumes
the appropriate signed phase and actual protected custody.

These transport changes and negative fixtures are source-only. Installed
inspection, graph acceptance, original preparation and native execution remain
unqualified until the canonical authority producers and managed graph are
integrated and exercised through the real user flow.
