# T3 session files

Status: authored source, not runtime qualification. This tranche starts from
public `7bfc7da24ecc5908004c367e6f21121ad3c83bd8`. File operations remain unbound
until the signed broker and original-human/resource authority producers are
integrated. No real session, source filesystem or credential was used to test
them. Statistics and provider credentials are outside the file lane.

The normal `@nessie/t3-session-source/engine` package exports the pinned original
upload, asset, attachment-store, held-media-file, HTTP range/header and workspace
modules as `FileUpload`, `FileAssets`, `FileStore`, `FileMedia`, `FileHttp` and
`FileWorkspace`. Original `AttachmentClaims` and `ThreadMessageIntake` continue
to handle sends, queue edits and question files. Original IDs, names, MIME types,
size limits and source metadata remain unchanged.

The `files` patch family follows extraction and precedes request privacy. It
extracts original URL codecs and HTTP file responses without importing the full
HTTP server. It requires host ports for signing/path admission and separates the
document-parser tag from its unmanaged launcher. It does not start `runServer`,
a provider, a native icon process or a credentialed media fetch.

## Required runtime admission

`FilePorts.FileAccess` has no default layer. Its producer must be the actual
canonical signed T3 runtime, after T03C authority and T08/T09 resource admission.
Callbacks in tests demonstrate algorithm behavior only. An actor string, path,
timestamp, descriptor, callback result or inventory observation is not proof.

Each operation binds the selected team, original human, exact executor,
environment and thread, physical root, connection epoch and runtime generation.
The service checks pending-upload ownership and destination affinity, every
already-claimed attachment, exact generated item/image identity and the admitted
workspace. A normalized thread prefix is never ownership evidence. Native
Codex/Claude assets need their own admitted source association; a T3 provider
choice or matching path cannot supply it.

The producer implements these required methods:

- `upload`, `bindUpload`, `pending`, `uploadDigest`, `uploaded`: authorize and
  retain original pending ID/metadata, optional expected SHA-256, original expiry
  and byte receipt under the existing operation identity.
- `claim`, `bindClaim`: admit every input before the original early return/copy
  and record the pending-to-claimed relationship before dispatch.
- `asset`, `bindAsset`, `assetToken`: authorize mint and use separately; bind
  the original token to actor, source, purpose and original expiry. Return expiry
  from that immutable receipt, never a request's claimed expiry.
- `path`, `recheck`: enforce physical custody, protected upload-directory
  ownership, provider/executor/internal-path denial and current revocation. The
  protected root remains held through each write/claim transaction. Lexical
  containment alone cannot supply this proof.

`AssetSigner` uses runtime-held key material. `FilePathPolicy` rejects credential
homes and executor internals. `FileDocuments.DocumentText` needs the admitted
native parser owner. None has a production implementation in this checkpoint.

## Bytes and recovery

`src/t3-session/files/service.ts` validates original codecs and calls the original
operations. Uploads stream to a private `.part`, enforce original length and an
optional admitted SHA-256, then publish by exclusive hard link. Identical retries
succeed; conflicting bytes never replace a file. Partial, oversized, mismatched
or revoked attempts remove their own part. Filesystems without atomic-link
publication are refused; no copy-to-final fallback exposes incomplete bytes.
Issuing a URL does not sweep another person's uploads. Separately admitted runtime
maintenance owns expiry reclamation.

Original claim copies preserve the pending retry source. Original message intake
releases unused claims after proven replay/rejection and retains them when
dispatch is uncertain. A byte receipt is not command admission, provider receipt
or completion. Retry retains the operation ID; the broker reconciles uncertain
outcomes before allocating another ID.

Asset reads keep the original no-follow descriptor until stream closure. Each
media chunk rechecks admission and descriptor size/mtime/ctime; replacement or
in-place mutation refuses subsequent chunks. The recorded URL deadline is checked
throughout reads. Original range/HEAD, safe disposition, MIME and HTML sandbox
behavior remain; resources use `private, no-store`. Generated tool images travel
as bounded binary chunks, never raw base64 in tool results. Credentialed
source-control media remains unavailable pending its separate owner.

The caller keeps the Effect scope alive until bytes finish or cancellation closes
the stream. Paths, signed inner tokens and runtime credentials are not substitutes
for the API's authenticated opaque resource handle.

## Verification

`patches/t3-session/files/verify-source.mjs` applies all five patch families to
the pinned Git objects and syntax-checks the affected original modules with
Node's builtin parser. It neither typechecks nor executes the engine. Run it with
a 128 MiB heap and a read-only source repository argument.

The authored `test:t3-session-files` gate consumes the normal generated engine and
executor build. It covers original upload/retry/hash/partial/expiry behavior,
foreign claim denial, original asset metadata, range/HEAD, revocation and held-file
mutation refusal. Synthetic admission services do not qualify real producers.
Run through Turbo with concurrency 1 and exported `DATABASE_URL`; the fixture
does not connect to PostgreSQL. Its test heap is capped at 512 MiB. No compiler
or test suite ran in the source-only window.

Required follow-up: signed broker binding, native held-root write proof,
receipt/epoch races, restart replay, original-human revocation, real queue/question
dispatch, generated files/images and native export from the authenticated route.
P24/P25 remain open.
