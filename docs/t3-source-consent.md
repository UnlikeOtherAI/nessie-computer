# Prospective T3 source consent

This source implements the Windows x64 native producer for prospective T3
read/import/publication consent. It has **not been compiled, run, installed or
qualified**. The physical producer is documented in [physical sources](t3-physical-source.md).
Other operating systems/architectures refuse. No live parity or all-machine
coverage follows from either implementation.

The actual whole-source review now forwards its transient native snapshot through
the tray-owned managed daemon's inherited pipes; capture, publication and finite
read registration follow [the runtime handoff](retained-runtime-handoff.md).
Selected grants remain unsupported in that capture doorway. Nothing is installed
or qualified by the source integration.

## Home and user actions

The existing bundled executor console's Settings section owns local T3 review.
The selected paired team determines the executor. Refresh lists that executor's
explicit configured roots and pending enrollment/import challenges. Offer creates
a public source-bound key proposal for one configured root. Review starts the
protected Windows ceremony for the selected queued challenge. Nothing auto-approves
when the page opens, receives a challenge, pairs or authenticates to UOA.

The backend's separate browser enrollment flow requires the current UOA recipient
to approve the exact enrollment/key fingerprint with fresh action verification.
The local review and backend action are both required. Public offers and signed
possession proofs remain pending until that browser approval. A signature proves
delegation through the explicitly approved key; it is **not remote binary
attestation**, historical human ownership or original-copy attestation.

The native secure credential prompt displays the full tuple, including recipient,
source, ordered selection and accepted unattested baseline. Enrollment displays
its source/recipient/key tuple; it grants no implicit thread selection. Source
identity strings use unambiguous escapes for invisible/directional characters.
An overlong prompt refuses instead of truncating scope. Windows password-backed
credential providers are the authored authentication path; Windows Hello and
passwordless accounts are unqualified and receive no fallback success.

## Local trust path

`native/src/t3_source/issuer_service.rs` adds a separate bounded local pipe listener
to the existing verified SYSTEM updater broker. It does not add signing to
`update-control`. Only an actual pinned/signed local tray process in the interactive
source owner's session can start a ceremony. The listener has no generic sign or
approve-boolean operation. Both directions authenticate actual kernel pipe peers.

The broker launches the pinned source helper using the session's actual token,
with explicit SYSTEM-owned process and thread security descriptors, no inherited
handles, and a minimal environment. It also protects the duplicated primary token
from duplication/default-DACL changes and installs an OWNER RIGHTS default DACL
for later authentication/watchdog threads. Process, primary thread and token ACLs
are read back before the suspended child resumes. Ordinary user processes get query/synchronize
access, without memory-write, thread-creation, duplicate-handle or ACL-write rights.
Creation-time extension-point disable and Microsoft-only DLL policies close the
same-desktop hook-DLL route that process ACLs alone do not cover. These policies
are read back before resume; unsupported policy/credential-provider combinations
refuse and remain part of the required positive installed qualification.
The broker retains the exact child process handle/generation and authenticates
that child on its private bootstrap/signing pipe. Merely launching a signed helper
or spoofing a parent PID cannot acquire that channel. Source acquisition uses the
helper's real OS profile/token and configured root, never a server-supplied path.

The helper opens the real held SQLite resource before review. It rechecks/renews
the source and issuer channel while waiting for Windows authentication and before
returning any result. Authentication verifies the returned logon token SID against
the actual non-elevated source owner. Credentials stay in native memory, are wiped,
and are neither saved nor sent to the daemon, server or signing broker.

SYSTEM stores an Ed25519 seed under the actual KnownFolder-derived updater root,
`Nessie Executor Updates/retained-import-issuers/<source-and-owner-hash>.seed`.
This private child directory and seed have SYSTEM-only ownership/DACL. The root
namespace and seed remain held without replacement sharing. Source identity plus
OS-owner SID indexes a product-specific issuer; no UOA profile or org hierarchy is
stored. Existing invalid, incomplete or substituted seed files refuse; there is no
automatic key repair/replacement. The source helper receives public keys and typed
signatures only. Neither it nor ordinary daemon code receives private seed bytes.
Preserve this directory across updates; deliberate removal requires a fresh key
and fresh explicit backend enrollment. Administrators/SYSTEM remain the OS trust
boundary, never a source of user consent.

The public key is Ed25519 SPKI DER in standard padded base64. `keyId` is lowercase
SHA256 of that DER. Signatures are standard padded base64 (64 decoded bytes).
Signing uses recursively sorted `canonicalExecutorJson({domain,payload})`:

| Domain | Exact payload |
| --- | --- |
| `nessie.t3.retained-import.issuer-enrollment.v1` | Server enrollment tuple: enrollmentId, nonce, executorId, environmentId, physicalRootKey, admittedRootKey, databaseIdentity, environmentIdentity, recipient, publicKey, keyId, expiresAtMs |
| `nessie.t3.retained-import.approval.v1` | `{challenge,receipt:receiptWithoutSignature}` |
| `nessie.t3.retained-import.live.v1` | Live proof without nativeSignature |

The challenge includes `issuerEnrollmentId` and `issuerKeyId`. Its digest uses
the exact ordered array in protocol `retainedImportChallengeDigestInput`, not the
signature wrapper. Both selection arrays preserve original order, contain unique
IDs, and are bounded to 64 entries/256 UTF-8 bytes per ID. `whole_source` has no
implicit truncated list. Project IDs are explicit original-source grants, not
an inferred mapping. Numeric Unix milliseconds satisfy
`now < grantExpiresAtMs <= expiresAtMs <= issuedAtMs + 300000`.

## Native lease and canonical consumer

The concrete API in `src/t3-session/source/owner.ts` is:

```ts
const lease = await machineT3Sources(executorId).consumeRetainedImportApproval({
  challenge, receipt, physicalSourceRecheck, verification,
})
lease.initialProof
await lease.recheck()                 // local guards only
const proof = await lease.recheck(nextVerification)
const withdrawn = await lease.revoke(revokeVerification)
await lease.revoke()                  // local revocation, no remote assertion
```

`physicalSourceRecheck` must be the exact still-live function issued by that
registered owner's `withReadonlySource` callback. Serialized identities and
caller closures cannot mint this lease. Consumption compares all physical
identities before and after native IPC; failures revoke the local scope.
The native private consumption token remains inside the executor closure.
`consumptionId` is SHA256 of its UTF-8 lowercase hex representation.

Signed live proofs contain version, operation, verification, issuerKeyId,
issuerInstance, receiptId, challengeDigest, consumptionId, observedAtMs,
expiresAtMs, nativeSignature. Verification has verificationId, nonce,
issuedAtMs and expiresAtMs. The backend issues/stores a one-use verification
bound to the operation/grant/lease/full receipt and consumes it atomically with
activation. Native duplicate verification IDs with changed inputs refuse;
identical retries return the stored proof while the resource remains live.
After local revocation/expiry the serving process ends; the backend can reconcile
an already returned identical signed proof, but cannot ask a dead process for a
new proof. No daemon `alive:true` or caller-supplied public key is accepted.

The tray retains its broker pipe until proved daemon drain/refusal, expiry, tray
exit or broker disconnect. Stop requests that drain; an uncertain handoff does
not imply release and prevents replacement. Broker exit closes the protected
child, source handles and receipt issuer.
No-argument guards never constitute remote proof. Backend enrollment/grant
revocation remains independently authoritative even while a local receipt lives.

## Application integration boundary

`executor_retained_status` and `executor_retained_action` are reachable Tauri
commands from the bundled local status window only. Offers/proofs use the shared
paired transport `retainedImportPost` and `/api/executor-daemon/retained-import`:
`issuer.offer`, `issuer.proof`, `issuer.pending`. Machine signatures authenticate
the transport and do not confer source-owner consent. The fixed `t3-retained
--executor UUID` management CLI has only roots/pending/offer/proof operations.

`executor_retained_snapshot(executorId)` returns `{challenge,receipt,expiresAtMs}`
only for the tray's retained local approval. This snapshot is not authority.
The tray now forwards it through its owned managed child's inherited liveness
pipe, using the bounded [runtime handoff](retained-runtime-handoff.md). The already
claimed daemon runs `withCapturedRetainedRuntime`, whose original local consumer
is `withRetainedImportLocally(stateDirectory, {challenge,receipt}, callback)`.
Actual capture, publication and catalog/read remain inside that callback with
its returned authority. There is no direct tray
`consent.commit`, fake original-owner port, durable approval JSON or substitute
capture implementation. The UI reports local approval; real import completion
and installed availability remain unclaimed until qualification.

Historical-human evidence remains unbound. Pinned original T3
`25bf84ab07f53f141c20239c63e383823a9d5ea0` has no authenticated V2 creation receipt;
retrospective original-copy provenance cannot be recovered from current ownership,
schema or a first-seen digest. The explicitly authorized prospective policy accepts
`not_attested_by_original_source` as a labeled baseline. A digest checks future
consistency only. Original source extension/migration options remain recorded in
the physical-source guide; this change writes no old T3 files.

## Qualification request — all executable checks pending

Reserve a separate Maxis heavy lane before running the commands below. Prepare
only this checkout's own dependencies and the normal `DATABASE_URL` test setting.
No sibling artifacts, native install or service change is implied by this list.

```powershell
Set-Location 'C:\Users\ondre\.t3\worktrees\Nessie\t3-5d316193\executor'
$env:NODE_OPTIONS = '--max-old-space-size=5120'
pnpm exec turbo run build typecheck test:t3-physical-source --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
cargo test --manifest-path native/Cargo.toml t3_source -- --test-threads=1
cargo check --manifest-path tray-windows/src-tauri/Cargo.toml
node test/manual/t3-retained-console.mjs
```

The five TS contract/denial tests and six native contract/denial tests are authored,
not run. Existing physical read/race cases remain unrun. The browser script is a
local headless renderer fixture, excluded from CI; it does not prove native trust.
Set `T3_CONSOLE_BROWSER_EXECUTABLE` to the lane's browser. Optional
`T3_CONSOLE_CAPTURE_PATH` must be outside tracked source. Capture actual base/final
Settings states separately before claiming visual verification.

The source-only pass after merging the protocol/transport prerequisite parsed
17 TypeScript files and three JSON files, checked five JavaScript files' syntax,
matched all six locale keysets and checked whitespace/owned-code line limits.
It executed no implementation modules and establishes no Rust, type, SQLite,
native UI or OS-permission result.

After a separately approved exact signed candidate and isolated installed setup,
manually use the real tray/backend enrollment, cancel, wrong-owner authentication,
accepted pending-human state, UOA approval, local import review, consume, changed
verification/replay, source replacement at each wait, expiry, disconnect and revoke.
Assert backend pending/revoked/replaced keys cannot activate; prove an unrelated
daemon cannot connect as tray/child, steal the seed, obtain dangerous process
rights or sign without the secure ceremony. The additional real OS denial probe:

```powershell
# Values identify the actual protected fixture ceremony; no default or skip.
$env:NESSIE_T3_TEST_CEREMONY_PID = '<fixture pid>'
$env:NESSIE_T3_TEST_CEREMONY_STARTED_AT = '<kernel creation timestamp>'
$env:NESSIE_T3_TEST_NATIVE_SHA256 = '<verified exact signed helper SHA256>'
$env:NESSIE_DESKTOP_WINDOWS_SIGNER_EKU = '<existing verified publisher profile EKU used for this candidate>'
cargo test --manifest-path native/Cargo.toml --features retained-issuer-installed-qualification --test retained_issuer_installed -- --test-threads=1
```

Run that probe as the ordinary source owner while the real fixture ceremony is
held. No production key/history is a test fixture. Positive SYSTEM protected
launch, credential-provider behavior, Windows process/thread ACL construction,
WinSQLite, IPC replay, translations/rendering and the full enrollment/import
journey all remain unqualified. T03C's tests and earlier importer passes do not
cover these new bytes.
The required Cargo feature selects only this installed test target; production
admission has no feature, fixture or default-success branch. Ordinary native
unit/CI runs do not execute the installed probe or a UI ceremony.
