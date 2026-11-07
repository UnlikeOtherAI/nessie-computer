# Mounted T3 client connection URLs

This is T19's source-only URL patch family. It does not register a UOA account,
start a T3 server, provide a gateway or establish installed/mobile compatibility.
It keeps the existing T3 remote synchronization, session screens, reducers,
history, queue, outbox and command semantics.

## Source inputs and patch API

The source is T3 commit `25bf84ab07f53f141c20239c63e383823a9d5ea0`, tree
`b0ba4dad62fa11e0a1fd21f5d351d75926d7559e`. The unmodified C02 capsule has
2,859 files, 52,121,600 bytes and SHA-256
`6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096`.
Neither the reference checkout's working files nor npm's `t3@0.1.7` downloader
is a build input.

`patches/t3-session/client-connection/boundary-patches.json` is an ordered C02
format-1 manifest. Each entry has the exact source revision, complete file
before/after SHA-256, unique replacement seam and expected semantics. Multiple
entries in one file bind the previous entry's result. Its companion
`web-boundary-patches.json` binds one web file omitted from the capsule. Do not
pretend that file came from the capsule: read its pinned committed Git object,
verify the tree and original file hash, then use C02's same patch API.

The capsule-family manifest SHA-256 is
`6dcdde835e1c4d1d02bdbafb63876494c60a5d2f93e045ab871d00cc5b4962f5`;
the separate web manifest SHA-256 is
`8006831332ef2361ef137d19f800a0d6abfe573281836db6ccd688f3bfc89e78`.

`index.mjs` exports `T3_CLIENT_CONNECTION_PATCHES` with both manifest digests,
and `applyClientConnectionPatches(snapshot)` /
`applyWebConnectionPatches(snapshot)`. Both delegate to the committed
`packaging/session-engine/patches.mjs` verifier. They copy no tar parser,
resolver or patch engine. Their import performs no source execution.

For final composition, T02 must concatenate C02's existing extraction entries
and the selected patch-family entries in a deterministic manifest before one
`applySessionEngineBoundaryPatches` call, and record that combined digest.
Chaining calls would overwrite `orderedPatchesSha256` with only the last
family's digest. The original archive remains byte-identical.

## URL contract

An environment base is an HTTP(S) directory, for example
`https://api.example/t3/environments/key%2Fopaque%25/`. The existing
`packages/shared/src/advertisedEndpoint.ts` owns the implementation:

- `normalizeHttpBaseUrl` maps WS→HTTP and WSS→HTTPS, retains the pathname and
  percent-encoded bytes, makes one trailing slash, and clears base query/hash.
  Applying it again has no effect. Original root-origin connections retain `/`.
- `environmentEndpointUrl` appends logical `/api/...`, `/oauth/...`, `/ws` and
  other original logical paths within that directory. Already mounted paths
  and same-environment absolute URLs are preserved once. Endpoint query and
  fragment survive; inherited base query/hash do not. Path parameters remain
  the original HTTP contract builder's responsibility and are encoded once.
- `environmentWebSocketUrl` preserves an explicit socket path, including `/ws`,
  or appends `/ws` to an environment base. HTTP/WS protocol equivalence, origin
  and mount must agree with the HTTP environment before a ticket/proof is
  requested. Socket query survives and fragments are removed. The DPoP upgrade
  target is the actual public HTTP(S) socket path, without query/fragment.
- `httpBaseUrlFromWebSocket` derives the environment directory from a web
  ws-only `/ws` setting. A paired HTTP base remains necessary when a custom
  socket path does not identify its environment directory.
- `environmentResourceUrl` resolves relative minted resources through that same
  boundary. An explicit absolute HTTP(S) resource retains its supplied origin:
  the original asset code deliberately returns local-media fallback resources
  from a different selected environment. It adds no bearer, DPoP or cookie
  header. This resource exception must never authorize a credential endpoint
  or an arbitrary gateway proxy. Existing upload cancellation/staging is intact.

Unsupported schemes, user information, control characters, backslashes,
malformed percent escapes, dot traversal and ambiguous internal empty segments
are rejected before URL normalization can erase them. Relative paths naming a
sibling in the environment mount namespace and duplicated mount prefixes are
rejected. A URL helper is routing hygiene, not an entitlement check: T08/T09
still admit the exact environment, subject/team and resource at the public URL.

The root `/pair` doorway continues resolving to the root base. A mounted
`.../<route-key>/pair` resolves to that mounted base. Hosted pairing hosts and
direct host/code input reuse the same normalization. Token extraction and
original structured pairing errors remain in their original code.

## Changed upstream inventory

The manifests contain all original/intermediate/final hashes and exact seams.
This table names the reason for every changed upstream file. Line counts are
original→patched; additions/deletions are from Git's line diff.

| Upstream file | Lines; diff | Necessary boundary change |
| --- | --- | --- |
| `packages/shared/src/advertisedEndpoint.ts` | 77→162; +93/−8 | Own canonical HTTP/base/resource/socket resolution. |
| `packages/shared/src/remote.ts` | 260→248; +18/−30 | Preserve mounted pairing bases; retain `/pair` behavior and validate raw input. |
| `packages/client-runtime/src/environment/endpoint.ts` | 9→1; +0/−8 | Re-export the shared implementation instead of overwriting pathname. |
| `packages/client-runtime/src/rpc/http.ts` | 170→165; +2/−7 | Retain the base mount for all three actual Effect HTTP constructors/builders. |
| `packages/client-runtime/src/authorization/remote.ts` | 359→357; +7/−9 | Validate socket scope before ticket/proof creation and use the public mounted socket. |
| `packages/client-runtime/src/state/assets.ts` | 386→387; +3/−2 | Resolve relative asset/upload URLs and local-media fallback through the common boundary. |
| `packages/client-runtime/src/connection/resolver.ts` | 331→329; +2/−4 | Repair the independent cookie-primary socket path. |
| `packages/client-runtime/src/voice-input/environment.ts` | 302→299; +3/−6 | Repair the demonstrated absolute speech-stream path bypass at connection creation. |
| `apps/web/src/environments/primary/target.ts` | 302→298; +6/−10 | Retain configured mount, ws-only `/ws` compatibility and the loopback dev proxy. Separate committed Git input. |

`state/preview.ts` constructs no URLs and needs no patch. Its preview/device
stream access uses `state/deviceHubAccess.ts`, which already calls
`environmentEndpointUrl`; that caller receives the shared repair. Mobile
`lib/attachmentUpload.ts` already resolves the minted URL through
`resolveAssetUrl` at transfer time, so it needs no edit. Web
`connection/runtime.ts` composes existing shared connection/snapshot layers and
contains no independent URL construction.

`relay/managedRelay.ts` uses the separate secure relay-origin contract and its
own contract URL builder/proof targets. Its Clerk/JWT account assumptions are
conditional T19B work after T08/T09, not a reason to change relay authority or
host a relay here. Generic MCP presentation and webhook URL helpers are outside
the admitted coding-session connection boundary and remain unchanged.

## Checks and resource limits

The pure Node check requires Node's TypeScript-stripping API and executes the
complete patched shared module plus exact uniquely bounded functions from the
pinned auth, asset, HTTP and primary-socket/web sources. It injects dependency
bindings, not another URL implementation. It does not substitute for full
Effect HTTP integration.

From the executor checkout, after a fresh load/headroom check:

```powershell
$env:T3_CLIENT_CONNECTION_SOURCE_REPOSITORY = '<read-only pinned Git repository>'
node --max-old-space-size=512 --test --test-concurrency=1 test/t3-session-client-connection/urls.test.mjs
```

`source-fixture.mjs` uses the producer's `prepareSessionEngineSource`,
`readSessionEngineSnapshot`, `verifySessionEngineSource` and resolver. It stores
only disposable synthetic build inputs under this worktree's ignored
`.artifacts/t19-client-connection/`. A preverified archive can instead be
supplied with `T3_CLIENT_CONNECTION_SOURCE_ARCHIVE`; the separate web check
still requires its committed Git source.

The full-module test uses only Effect `4.1.2`, with its
exact integrity from C02's lock. Effect has no dependency entries in that lock.
`prepare-dependencies.mjs` writes a minimal isolated package and lock under the
owned artifact directory and refuses conflicting existing inputs. It does not
install anything. Run only in a coordinator-allocated resource lane, with a
fresh load/headroom check before each job, at least 10 GiB free, a 1,536 MiB heap
cap and sequential commands. The auxiliary lane used for this verification did
not require or claim release of T01's priority slot:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=1536'
node test/t3-session-client-connection/prepare-dependencies.mjs
pnpm --dir .artifacts/t19-client-connection/dependencies install --ignore-workspace --frozen-lockfile --ignore-scripts --ignore-pnpmfile --child-concurrency=1 --network-concurrency=1 --store-dir .artifacts/t19-client-connection/dependency-store
$env:T3_CLIENT_CONNECTION_DEPENDENCY_DIRECTORY = (Resolve-Path .artifacts/t19-client-connection/dependencies).Path
node --experimental-vm-modules --test --test-concurrency=1 test/t3-session-client-connection/http-auth.test.mjs
```

The VM loader executes original patched modules through C02's resolver and one
owned pinned Effect singleton. No source-checkout modules or another worktree's
dependencies are consumed; resolved dependency files must remain inside the
explicit owned directory after realpath resolution. Both Effect's root export
and its subpaths are admitted. Fetch fixtures are synthetic in-memory responses;
they never call a live gateway or provider. The web-only disabled-environment
switch is injected for that boundary test. No cloud/device identity is supplied;
the unrelated telemetry hash import is a fail-closed binding that throws if
called, avoiding an additional hashing dependency. Full HTTP/auth modules and their
original contracts/codecs are executed, rather than mocked clients/builders.
Ordinary authenticated HTTP and preview/speech constructors use exact source
function slices with actual Effect and explicit dependency bindings to avoid
activating unrelated application graphs.

## Verified fixture result — 7 November 2026

The final full-module run passed **11 tests, 0 failed, 0 skipped**. The pure
actual-source gate passed **10 tests, 0 failed, 0 skipped**. Both ran sequentially
on Windows Maxis, Windows 11 Pro `10.0.26300`, Node `24.19.0`, pnpm `10.22.0`,
from private base `0de1eb1a59118671cb31fbc2304e125dbf473840` and public executor
base `04c853ab79997a6ef20a8355aa6d6574ecd5bba1`. The test-only corrections do not
change either URL patch manifest, source hash, patch API or patched-file hash.

The owned Effect fixture has package-manifest SHA-256
`a243083c6d82d436139047f6c638b7d6e4025e3863922013ccee3c9f806a8911`
and lock SHA-256
`2d4df57e4280fb6f0b326f38df036fdd89895572c27ca3fee8894048f34fa99b`.
Its sole dependency is Effect `4.1.2`, integrity
`sha512-d3Oah1WyKxFLFh19yWheS5IXIVaITzxZ71JkE1rkUozq/6EcJSU5nPk5bF2QrSygZ3SQoiNQB8TsxFriyMeMaQ==`.
The frozen, lifecycle-disabled install above downloaded one package. The
manifest and lock remained byte-identical after installation.

The real Effect `urlBuilder`, group and full-client constructors exercised
loopback/root/mounted environments, once-encoded path parameters, opaque query
values and protocol headers. Original codecs decoded access tokens, redacted
tickets and descriptors. Ordinary DPoP HTTP proofs matched the fetch URL on both
the initial request and the one permitted auth retry. The retry reported the
rejected token and retained the selected direct environment even when renewal
returned a different base.

Bearer and DPoP socket tests exercised ticket audiences, the legacy bare-path
404 fallback and the mounted upgrade proof. A DPoP ticket request without a new
fallback proof made no fallback request. Wrong origins, sibling/root mounts,
protocol downgrade, traversal and unsupported schemes failed before credential
property reads, proof creation or fetch. Original typed rejection, malformed
JSON/schema responses, undeclared status, transport failure and timeout with
fetch cancellation retained their original failure categories.

The remaining fixture checks exercised pairing, descriptor/protocol negotiation,
preview/device and speech constructors, configured web mounts, ws-only settings
and the loopback dev proxy. The pure gate also exercised explicit custom socket
paths, cookie-primary socket construction, minted resources and the deliberate
absolute local-media resource exception alongside credential-endpoint rejection.

At `22:16:35Z`, the final Effect run started with 13.64 GiB free and 28% CPU,
using the 1,536 MiB heap cap. At `22:17:41Z`, the pure gate started with
12.89 GiB free and 76% CPU, using a 512 MiB heap cap. The auxiliary lane was
released after these commands exited; T01's priority lane was never claimed.

These are synthetic in-memory-fetch fixtures against pinned source, not live
HTTP acceptance. Packaged Node 22, real config/readiness lifecycle, browser,
mobile, gateway and provider acceptance remain unverified. No native build,
install, database, retained session, provider or credential was accessed.

## Integration requests and remaining work

T01 owns package/Turbo/CI registration: add a focused machine-only
`test:t3-session-client-connection` task for the pure gate, retaining its source
input prerequisites, and a separately explicit dependency-backed check if that
fits the foundation's toolchain. No root manifest, lock, barrel or CI file is
changed by this tranche. T02 owns final deterministic patch composition, source
inventory and generated browser-safe exports. The coordinator advances the
private executor pin only after public integration.

T19B still needs the canonical UOA account adapter, complete entitled directory
registration and cleanup/renewal after T08/T09; no fake Clerk JWT is introduced.
The reserved future fork files are:

- `apps/mobile/src/features/cloud/CloudAuthProvider.tsx`,
  `cloudAccountService.ts`, `publicConfig.ts`, and `ConnectOnboardingRouteScreen.tsx`;
- `apps/mobile/src/connection/platform.ts` and
  `apps/mobile/src/features/connection/{CloudEnvironmentRows,ConnectionsNewRouteScreen}.tsx`;
- conditionally, `apps/mobile/src/connection/{catalog,catalog-store,storage}.ts`
  and `apps/mobile/src/state/use-remote-environment-registry.ts` for scoped cleanup;
- conditionally, `packages/client-runtime/src/relay/managedRelay.ts` and
  `packages/shared/src/relayJwt.ts` if the relay-shaped option is selected;
- the web account/registration boundary in `apps/web/src/connection/platform.ts`
  and `apps/web/src/environments/primary/auth.ts`, alongside the already declared
  primary target patch;
- `apps/mobile/src/connection/runtime.ts` and
  `apps/mobile/src/features/threads/use-composer-command-menu.ts` only where the
  existing capability flags do not already omit excluded usage displays.

The conditional v2 uncertain-dispatch fix needs gateway receipt evidence before
changing `apps/mobile/src/state/thread-outbox-model.ts` or the shared typed
dispatch/error boundary. Capability configuration must exclude usage/billing
surfaces in the later client fork. A future T3 fork/release, actual T3 sync against the
gateway, config/readiness lifecycle, phone byte transfers and native installed
evidence remain separate deliveries.
