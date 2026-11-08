# Proposed selected-instance secret read

Source contract, 8 November 2026. Shared wire schemas, native plan reconstruction
and an immutable tool-record consumer are authored; the fixed child and dedicated
delivery path are not yet wired. No working resolver or positive read is claimed.
The first scope is
one original selected-instance OnePassword reference and its destination slot.
Workspace, git, attachments, scripts and Codex overlay mutations remain denied.

## Existing observations

`execution_resource::Held` retains duplicated settings/configuration/source/home
handles, exact settings bytes digest, physical identities and resource generation.
Its recheck verifies watches, bytes, local registration link and actual helper,
graph and supervisor generations. `bind_graph` retains the exact accepted graph
nonce/digest. `resolve_launch_homes` requires that accepted graph and resolves its
selected provider's credential reference to a held directory. That reference
proves a HOME object, not the contents of a credential store.

The service does not currently decode original secret-reference annotations,
observe resolver cache state, invoke OnePassword, or release a secret. Existing
`pin_execution_image` prevents replacement while held but explicitly confers no
image trust. Existing provider/history creation requires a reservation and must
not be reused to invent a pre-session provider identity.

## Plan evidence

The original pinned registry selects environment non-string references in array
order, then annotated settings references in original codec property order;
keyed references retain record insertion order. Selection scans raw entry.config.
Decoded driver defaults must not invent references. Runtime owns the shared
original selector and keeps the plan and selected destination graph-local.

Native must reconstruct the reference-bearing subset from its held settings,
using reviewed pinned Codex/Claude annotations and original slot order. It must
compare the complete candidate plan, not accept a plan hash as evidence. A
service-private plan retains the actual graph, accepted graph nonce/digest,
selected instance and credential HOME, resource/settings identities, and source
generation. Unknown codec shapes or unsupported secret drivers refuse.

Keep three digests distinct: physical settingsDigest hashes exact file bytes;
providerConfigDigest hashes canonical original ProviderInstanceConfig encoding;
secretProvidersDigest hashes canonical original ServerSettings.secretProviders
encoding. Native must reproduce those encodings before attesting equality.
planDigest binds the exact ordered references and destination slots, including
the original configuration digests. No value or hash of a secret value is evidence.

## Proposed native transitions

These are design names, not exported APIs or frozen wire schemas:

1. HoldPlan(resourceId, acceptedGraphNonce, candidatePlan) authenticates the actual
   graph, independently reconstructs the plan and retains it under native planId.
2. PrepareRead(planId, slotIndex) selects the native-held reference, configured
   OnePassword account and recipient. It creates readId/nonce and an enrolled-key
   intent receipt. No read occurs. Caller executable/account/reference/recipient
   substitutions are not accepted by this operation.
3. ConsumeRead(signedAdmission) independently verifies the backend's current
   original operation admission, exact receipt digest, complete binding and
   current resource. It claims the read and nonce before any child resumes.
4. A new fixed SYSTEM creator transition selects the held descriptor by readId,
   creates suspended with existing creation-time protection and nested Job, and
   transfers stdout solely to the service. Service registers and resumes it once.
   The only command shape is the original single-read command:
   op --cache=false read --account=<held account> --no-newline <held reference>.
5. Service buffers bounded output privately, waits for zero exit, stdout EOF and
   independently empty child Job, and rechecks the held resource/graph. It releases
   bytes once over a dedicated private channel to the exact authenticated graph
   generation and internal selected-slot sink. No general stdout facade, callback
   registration, daemon DTO, log or receipt carries secret values. Uncertain
   delivery is consumed and cannot be replayed. Failure wipes buffered values.

The immutable runtime adapter owns that sink and assigns the result only to the
retained original slot. It must bypass batch inject, temporary templates, fallback,
global cache and invalidate in this finite path. Every slot requires its own read;
duplicate references do not implicitly share values or permissions. No driver
construction or other mutation follows merely because a read succeeded.

## Agreed wire and lifetime

The preparation receipt would bind action selected-provider-secret-read, full
original Binding (including graph sourceEvidenceDigest), custody, resourceId and
generation, settings identity/digest, both configuration digests, planId/digest,
slotIndex and exact destination, reference/account identity, selected immutable
image digest, exact process-descriptor digest, recipient graph generation,
readId/nonce and finite timestamps. It contains no reservationId, providerSessionId
or nativeId. The backend verifies this independently enrolled receipt and derives
the admission only from the current opaque original operation.

A new fixed op-read role, creator journal, service-held output and dedicated
recipient delivery channel are required; none exists today. The image must come
from an explicitly trusted immutable tool installation/release record. Ambient
PATH/resolveSpawnCommand or merely hashing a caller-selected op.exe is insufficient.
The accepted installation record is optional manifest.executionTools.onePassword
with version, sha256 and publisherSubject. Its fixed image is
tools/onepassword/op.exe under the same protected release. Construction verifies
the original Agilebits Authenticode chain, publisher, timestamp and version;
the native consumer checks the already verified release manifest digest, pins
the protected directory/image namespace and rechecks image hash. It cannot enroll
a user-profile WinGet candidate. Account/profile selection and environment must be fixed from
held configuration and reviewed original driver semantics; arbitrary inherited
OP_* variables or an alternate process loader cannot select credentials.

Root and backend accepted a hard TOTAL five seconds from the native observation,
further bounded by all original operation/source/graph/relay/issuer deadlines.
Acceptance, child execution, EOF/zero exit/empty Job and sink delivery must all
finish before that absolute deadline. A 45-second timeout cannot be
inherited. Local read permission is not permission for automatic signin
or another account prompt flow. Startup, timeout and uncertain-release retries
require explicit original operation reconciliation, never synthetic renewal.

Permanent uniqueness is the accepted graph plus original full-array environment
index, not planId/readId/slotId. Exact retries can return unchanged evidence or
refuse; substitutions and timeout cannot mint a fresh read window. Duplicate
reference strings at different indices remain distinct slots.

`execution-secret-read.ts` exports T3ExecutionSecretPlanCandidateSchema,
T3ExecutionSecretReadPreparationPayloadSchema and T3ExecutionSecretReadAdmissionSchema.
Domains are nessie.t3.execution.secret-read-preparation.v1 and
nessie.t3.execution.secret-read.v1, respectively. Signing uses the existing exact
domain + U+000A + payload UTF8 helper; preparationReceiptDigest is SHA256 of the
exact signed preparation payload. planDigest is SHA256 of canonical sorted JSON
of the complete {evidence,selection} candidate that native independently verified.
settingsDigest remains bare64 exact-file SHA, unlike the prefixed configuration
digests. The signed tool observation includes actual ownerProfileIdentity,
environmentDigest and processDescriptorDigest; those observations still require
the actual protected producer before any receipt may be issued.

Post-association grants remain unchanged. Root owns compiler,
signing, immutable tool installation and actual secret-read/clearance qualification;
no secret values should appear in that evidence.

Root inspected only --version, --help and read --help for the existing Maxis
2.41.1 candidate. It is vendor-signed but user-profile installed, and those help
surfaces show no explicit no-input/noninteractive flag. No actual read occurred.
The current source must not enable execution or release on the assumption that
OP_BIOMETRIC_UNLOCK_ENABLED=false plus closed stdin/TTY suppresses every prompt.
A reviewed version-specific noninteractive behavior contract remains required.
The trusted installation record and the five-second kill deadline do not supply
that proof. No live read-start client or native secret producer is available yet.

## Dedicated slot receiver ABI

The runtime's private sink owns the dedicated connection and buffering. It does
not use ProtectedT3Provider stdout, JSON/base64 values or a callback registered
by a grant. The existing SYSTEM-created graph key authenticates this private
channel; it never enters the runtime descriptor or the daemon lane.

After service-observed zero exit, EOF and empty child Job, native emits exactly:
u32le headerByteLength, strict UTF8 JSON header, u32le valueByteLength, raw value,
32-byte HMAC-SHA256. Header is at most 4096 bytes; value is at most 65536 bytes.
No partial value is installed. The MAC input is UTF8 of
nessie.t3.execution.secret-delivery.v1 plus U+000A, followed by those two lengths
and their corresponding exact bytes in wire order (excluding the MAC).

T3ExecutionSecretDeliveryHeaderSchema fixes version=1, type=t3.secret.value,
graphId, readId, slotId, admission nonce, admissionDigest (SHA256 of exact signed
admission payload), recipient generation, observed child generation,
expiresAtMs, byteLength and clearance=service-observed-job-empty.

The private runtime module imports verifyProtectedT3SecretDelivery and
protectedT3SecretInstalledFrame from src/t3-protected-process.ts. The verifier
accepts (headerBytes, ownedValueBytes, proofBytes, exactSignedAdmission), checks
the private startup key and current graph/read/recipient/deadline, permanently
rejects duplicate accepted-graph/environment-index delivery, and returns only an
opaque VerifiedT3SecretDelivery token. It returns no secret and cannot register
an installer. Runtime installs its owned bytes synchronously into its private
preselected slot only after verification; scope/expiry/loss must clear values.

Only after installation does protectedT3SecretInstalledFrame(token) consume that
one-use token and produce a nonsecret acknowledgement. Raw admissions cannot mint
ACKs. ACK framing is u32le JSON length, canonical UTF8 JSON, 32-byte HMAC-SHA256;
MAC domain is nessie.t3.execution.secret-installed.v1 plus U+000A, followed by
length and header. Header fixes version=1, type=t3.secret.installed, graphId,
readId, slotId, admission nonce and expiresAtMs. Private native delivery must
verify this ACK before its same absolute deadline. No late ACK restores a read.

The receiver must copy incoming bytes into private bounded buffers, reject extra
frames/trailing bytes, recheck deadline before installing/acknowledging, and wipe
buffers on every terminal path. Receipt, ACK and close metadata never include
secret values or value digests. Native must additionally report positive child
clearance; connection EOF is not clearance. These authored receiver checks do
not add the missing native producer or establish noninteractive op eligibility.
