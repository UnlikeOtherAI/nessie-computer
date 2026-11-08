# T3 client connection URLs and UOA lifecycle

This is T19's source-only URL and registry patch family, with an unbound UOA
account/bootstrap adapter. It does not register a live UOA account, start a T3
server, provide a gateway or establish installed/mobile compatibility.
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

`index.mjs` exports `T3_CLIENT_CONNECTION_PATCHES` with the URL, web and registry manifest digests,
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

T19B's adapter source is described below. Its canonical UOA account, complete
entitled directory and durable account-cleanup bindings still need T08/T09
integration; no fake Clerk JWT is introduced.
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

## T19B source checkpoint — 8 November 2026

`registry-patches.json` adds two upstream files to the nine-file URL inventory:

| Upstream file | Change |
| --- | --- |
| `packages/client-runtime/src/connection/registry.ts` | Remove the live entry and close its original supervisor before persistent cleanup. Retain failed credential/cache/outbox/trust cleanup for repeated empty reconciliation, and refuse reinstallation until it succeeds. Failed credential replacement or changed addresses withdraw the old connection. Preserve explicit disabled intent across refresh and renewal. |
| `packages/client-runtime/src/platform/storageDocument.ts` | Persist the existing disabled-environment preference for platform entries, which intentionally have no saved connection target. Both original mobile and web storage adapters use this function. |

`applyRegistryConnectionPatches` uses the same full-file hashes and unique seams
as the URL family. T02 must include `registryConnectionManifestBytes` after the
client URL family in the final ordered manifest; no shared producer/export
registration is changed here. There are now **11 changed upstream files total**.
No Home screen, session screen, catalog grouping, history reducer, outbox reducer,
provider or server composition changes. The original reference checkout is read
only through committed Git objects at `25bf84ab07f53f141c20239c63e383823a9d5ea0`.

Three first-party TypeScript modules live beside the manifests:

- `uoa-account.ts` owns expiring connection leases only. `setAccount`, `refresh`
  and `dispose` share one serialized registry mutation path. A subject, org,
  selected team or sign-in-session change cancels old discovery/bootstrap and
  withdraws registrations. Late replies cannot reintroduce the previous scope.
  Directory order and exact environment IDs survive. Offline status is not
  interpreted as deletion. Transient failures retain existing leases only until
  expiry; explicit denial withdraws them. Account and credential deadlines have
  independent withdrawal timers. No profiles, memberships or session history
  are stored in this adapter.
- `uoa-bootstrap.ts` runs the original Effect descriptor and OAuth functions.
  It confines endpoints to the configured HTTPS API origin and environment
  mount, checks the expected original environment and protocol before requesting
  bootstrap material, and checks the returned endpoint/expiry before exchange.
  A DPoP token cannot enter the bearer-registration path. The existing mounted
  URL family still owns HTTP, WS, ticket and DPoP target semantics.
- `uoa-runtime.ts` acquires the original registry and HTTP services in their
  scope. It connects the lifecycle to `reconcilePlatform` and the real bootstrap
  function, translates original authentication/scope denials, and disposes on
  scope exit. Importing it starts nothing. It has no Clerk or usage-service
  dependency and creates no second session store.

These modules are not registered in a shipped fork or engine export. They are
source for the compatible client's existing account/platform boundary. T19's
next composition step must bind them only after the parent integrates T08/T09;
an injected port is not proof of a live authority or ready source.

### Exact prerequisite interfaces

The host must supply `UoaRuntimePorts`, calling the canonical operations that
also back UI/WebMCP/MCP. Do not create a second directory or auth endpoint:

1. Current UOA account events supply stable `subject`, `organizationId`,
   `teamId`, non-secret `sessionId` and `expiresAt` in epoch milliseconds.
   `sessionId` changes on reauthentication, not routine token refresh. Logout,
   revoked admission and selected-team changes call `setAccount` immediately.
   These client references confer no authority: T08 checks current UOA admission
   and exact selected team for every directory/connect operation.
2. `prepare(account, signal)` completes the existing account transition's
   durable credential/cache/composer/outbox cleanup, including a persisted
   previous account on cold start. It must retain failed cleanup for a later
   process restart. Registration and refresh remain blocked if it fails. The
   registry's new in-memory retry set alone cannot establish crash recovery.
   Bind this through the original mobile/web account/catalog storage boundary;
   do not supply a successful no-op or a new identity store.
3. `list(account, signal)` returns the complete owner-entitled selected-team
   directory as `UoaEnvironment[]`, preserving its order, labels and exact
   `environmentId` plus `endpoint.httpBaseUrl/wsBaseUrl`. Include offline entries.
   A malformed/duplicate identity set fails closed. No project filter or native
   Codex/Claude substitution may change the T3 environment identities.
4. `connect(account, environmentId, signal)` returns the decoded original
   `{environmentId, endpoint, credential, expiresAt}` shape. Its credential is
   short-lived one-use bootstrap material. Endpoints are canonical public
   `/t3/environments/<opaque-route-key>/` paths; `expiresAt` is an ISO timestamp.
   Both directory and connect map real revoked/expired/forbidden admission to
   `UoaConnectionDenied`, and preserve transient failure separately. Offline
   executor presence must not require contacting a separate T3 server to mint
   a gateway-scoped credential. If T08 cannot authorize offline entries yet,
   automatic offline registration remains blocked; no placeholder token is used.
5. T09 serves the original descriptor, form-encoded `/oauth/token`, HTTP APIs
   and WS ticket/socket schemas under that mount, with truthful config/source
   readiness. Descriptor acceptance is not a readiness verdict. No client code
   here marks retained capture or a native source ready.

The account surface and mobile `connection/platform.ts` must consume these
operations, preserve foreground/network-path wakeups, and retire old Clerk
account gates rather than impersonate them. Existing account UI translation,
cold-link presentation, WebMCP/MCP bindings and final browser/mobile composition
remain owner integration work. No user-facing strings are introduced here.

### Verification recorded at this checkpoint

On Maxis, Windows, Node `24.19.0`, public base
`7bfc7da24ecc5908004c367e6f21121ad3c83bd8` and private base
`426cafa72642f6addd72712779e3da639bb26084`, these source/tiny commands passed:

```powershell
$env:T3_CLIENT_CONNECTION_SOURCE_REPOSITORY = 'C:/Users/ondre/Projects/t3code'
node --max-old-space-size=384 --test --test-concurrency=1 test/t3-session-client-connection/uoa-account.test.mjs
node --max-old-space-size=384 --test --test-concurrency=1 test/t3-session-client-connection/registry-source.test.mjs
```

Results: **12 lifecycle tests and 2 source tests passed, zero skips**. Lifecycle
tests use synthetic directory, registry and clock ports. The source probe reads
the two exact original Git objects, verifies all patch hashes, strips TypeScript
with Node, and executes the patched catalog preference function. Node syntax
checks passed for both newly authored runtime fixture files and stripped all
three first-party TypeScript files. This is not a TypeScript typecheck.

The following fixtures are **authored, syntax checked, not run**. They require
an owned pinned Effect dependency root and the parent's serial heavy window:

```powershell
node --max-old-space-size=512 --experimental-vm-modules --test --test-concurrency=1 test/t3-session-client-connection/registry-runtime.test.mjs
node --max-old-space-size=512 --experimental-vm-modules --test --test-concurrency=1 test/t3-session-client-connection/uoa-bootstrap.test.mjs
```

The registry fixture uses the actual pinned registry and supervisor with
synthetic storage/transport to cover withdrawal despite multiple failures,
retry, failed credential renewal, cold identity lookup, offline/reconnect and
disabled intent. The bootstrap fixture uses original HTTP/descriptor/OAuth
modules and codecs with synthetic fetch responses to cover the mounted happy
path, wrong descriptor, changed endpoint, expired/cancelled authority and token
type mismatch. They establish no acceptance until actually executed. Run the
existing URL and HTTP/auth gates alongside them in the authorized window; their
historical results above were not rerun for this checkpoint. T01 owns adding
the new files to the appropriate focused Turbo tasks.

No install, compiler, Turbo, database, server, browser, native build, signing,
provider mutation, personal-history read or memory polling ran in this tranche.
Strict typecheck, runtime fixtures, real UOA denial/revocation, cold links through
the original mobile Home flow, gateway offline/reconnect, selected-team changes,
and UI/WebMCP/MCP user journeys remain unverified and required before delivery.

## Client export and host composition

The browser-safe original selectors, projections and history machinery now have
a dedicated generated `/client` entry under the [package contract](session-engine-package.md#original-browser-client-entry-source-checkpoint-not-yet-qualified).
This is an additive producer change. The original-source changes comprise
the registered URL helper, registry lifecycle and scoped host-factory patches; the eleven mobile
Git inputs only undergo build-time declaration selection, and shared reducers,
Home and screens retain their original implementation. `Client.ts` adds exports;
it creates no application or session store. Optional metadata, clock and scheduler
ports are omitted when absent to respect exact optional-property checking.

T08 supplies the real canonical `listT3Environments`, read/connect/admit/renew
operations and durable one-use credentials (`20261108006000`). T09 supplies the
mounted original raw HTTP/WS codec routes and DPoP verification boundary. The
account adapter's `list` and `connect` ports must call those canonical operations
under the current UOA subject, organization and selected team; endpoint strings
and historical capture do not establish admission. `prepare(account, signal)`
still needs an actual host implementation that deletes prior account credentials,
cached shells/history and pending outbox data before reconciliation, including
cold startup and cleanup failure recovery. An arbitrary successful callback is
not evidence of cleanup. No live binding is claimed in this checkpoint.

All new package runtime and declaration fixtures await the parent's combined
producer qualification. The dependency-free graph checks exercise only rejection
and reachability of synthetic build metadata; they do not establish a usable
browser runtime, identity authority or physical source readiness.

## Finite browser detail host

`BrowserThreadHost.open` from `@nessie/t3-session-source/client` implements the
read-only detail composition. Its input is the original decoded
`RelayEnvironmentConnectResponse`, original `threadId`, opaque `scopeKey`, actual
`authorizationExpiresAt`, an `AbortSignal`, and `onState(EnvironmentThreadState)`.
The detail owner resolves and checks the existing canonical UUID detail routes
before calling it. `scopeKey` combines the current team content generation and
checked detail identity; it is neither a token nor an admission assertion.
Nessie API success-envelope decoding stays in that facade. Original mounted T3
descriptor, OAuth, HTTP snapshot and WebSocket routes remain raw.

The handle exposes `loadEarlier(throughEntryId?, workAnchorId?)`,
`readItem(originalGetTurnItemInput, signal)`, `dispose(): Promise<void>` and
`closed: Promise<void>`. The latter resolves immediately when the host retires;
the detail owner must clear its displayed state then. `dispose` separately waits
for original Effect scope closure and persistent cleanup and rejects on failure.
Bootstrap completion never calls `onState`; every callback comes from the
original `Threads.makeEnvironmentThreadState` subscription. Reads use the
original RPC request function; cross-thread item requests are rejected.

The host assembles the original supervisor, driver, bearer resolver, RPC session,
bounded snapshot loader and history controller. It does not create the general
relay-discovery layer or supply Clerk/usage services. Four hash-checked edits in
`host-patches.json` lift the original descriptor/bearer authorization functions
into a shared factory, retain their original bodies, and expose restricted
bearer layers. Original full-host factories remain available. Unsupported
primary, relay, SSH and DPoP renewal paths explicitly fail. Existing URL patches
still determine exact mounted HTTP/WS/proof semantics.

The public original namespaces added for composition are `EnvironmentSupervisor`,
`EnvironmentRegistry`, `ConnectionDriver`, `ConnectionResolver`,
`ConnectionCredentials`, `ConnectionCatalog`, `ConnectionModel`, `Persistence`,
`Authorization`, `BearerAuthorization`, `BoundedThreadSnapshotLoader` and `Rpc`.
The finite host owns one supervisor directly; it does not create a second
environment registry or session store. Its platform cache adapter serializes
only the original `StoredOrchestrationThreadSnapshot` codec, bound to the exact
environment/thread. Environment-wide cache operations are unavailable.

Credentials remain in memory. Browser sessionStorage under
`nessie:t3-detail:v1:` holds the non-authoritative original thread cache. A cold
open removes stale owned keys before spending a credential. Each lifetime has a
unique suffix, so an old finalizer cannot clear its successor. Account/team
change, route abort, scope replacement, original supervisor blocking, or the
earlier of admission/access-token expiry immediately disables reads/writes,
clears the credential slot and closes the original scope. Persistent deletion
tries every owned key; failures leave keys available for retry and block the
next opening until cleanup succeeds. Late cache writes cannot resurrect data.
Only this host's namespace is removed; unrelated browser and original T3 app
data is untouched. No cleanup callback or success boolean stands in for removal.

This `thread_read` host creates no mutation queue or outbox. Retirement also
purges any residual pending-data keys within its owned namespace; the synthetic
cleanup fixture exercises that boundary. It does not claim to drain a separately
running original mobile application's outbox. General environment discovery and
the older `createUoaConnectionAccount.prepare` binding remain separate from this
finite detail lifecycle. Renewing the view requires a new checked canonical
detail/connect and remount; no expiry extension is inferred locally.

Source checks on Maxis, Node 24.19.0, 384 MiB: four storage-retirement fixtures,
four browser-input-graph fixtures and one exact-original host-extraction fixture
passed. Builtin stripping checks syntax only.
The ten-family composition also applied successfully to 85 exact original Git
files (137 resulting files), with ordered digest
`ee31451828ab5dc42b49ed53fc78f0bc38223908bb8e9069f3096115e8dc2303`.
New normal-producer host refusal
fixtures and strict consumer types are authored but unrun. The normal client
Turbo gate, real browser cold links, offline/reconnect, revoked/expired grants,
team changes and user/tool detail journeys still need the serial qualification
window. No live host acceptance is claimed by these source checks.
