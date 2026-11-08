# Prospective retained import authority

`packages/protocol/src/retained-import{,-issuer}.ts` defines the finite canonical
operations for explicit source issuer enrollment, import challenges and read
leases. Pending offers and pending enrollment are not authority. The server pins
an exact Ed25519 public key only after protected local possession proof and a
current UOA person's action verification of that exact source/key delegation.
This is prospective permission, not historical ownership, original-copy proof
or remote attestation of the native binary.

Key format is DER SPKI encoded as base64; fingerprint is lowercase SHA256 of
those DER bytes. Signatures are base64. Signing uses recursively sorted canonical
JSON with separate issuer-enrollment, approval and live domains. The source owner
owns protected signing and online consume/recheck/revoke. The daemon transport
signature alone cannot replace that proof. Native OS affirmation is not an agent
tool. Tools may prepare a review or inspect status through the same canonical
actions; affirmative UOA enrollment requires interactive step-up.

Native live proofs use a server-issued one-use verification nonce. Import
approval binds the exact challenge/receipt, source tuple, recipient, original
selection IDs, capture generation and explicit acceptance of
`not_attested_by_original_source`. V1 consent and grant expire within five
minutes; read leases expire within 60 seconds and cannot slide their deadline.
Whole-source capture remains whole-source; a partial grant cannot claim a
complete capture or read ungranted inherited history.

These contracts and dependent composition are source-only. No compiler, test,
server or native qualification is claimed. Parent integration must exercise the
actual protected enrollment ceremony, current UOA step-up, local online proof,
revocation and selected-team denial before any positive import claim.

The production callback is `withRetainedImportLocally(stateDirectory,
{challenge,receipt}, use)` in `src/t3-session/ownership/import-scope.ts`. It obtains
the registered physical owner itself, holds the exact source callback, consumes
the native approval with a server verification nonce, commits the enrolled
signature plus live proof, and revokes at callback exit. `RetainedImportLocalContext`
exposes the real held `source`, `database`, `physicalSourceRecheck`, issued `captureGeneration`,
active grant status, and `authority(serverLeaseDescriptor)`. That authority has
the distinct prospective `withReadScope`, `withCatalogPublicationScope` and catalog
`withCatalogReadScope`. A scope verifies native liveness and the backend lease
before/after use and every thread/source/selection recheck. Escaped callbacks fail.
`recheckLocalConsent` checks only local liveness; it is not server admission.
Catalog selections use the original source's branded thread/project IDs, with
frozen arrays that preserve the explicitly granted order.

Capture uses `RetainedCapturePorts.importRead`, never `originalOwner`. The caller
must provide the existing capture journal/workspace and perform the original
capture/read/catalog operation inside this callback. It cannot return a live
graph after callback exit, derive native execution authority, or manufacture a
ready association from the tuple. The tray-to-runtime callback registration and
the parent-integrated native producer still require actual journey qualification.

During unrelated waits, the caller must recheck the held source and local consent
at least every 20 seconds; this preserves the physical producer's 55/60-second
idle fence. It does not extend the hard native consent or backend lease expiry.
