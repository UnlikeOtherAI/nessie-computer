# Held execution settings and provider homes

Status: authored Windows x64 implementation, pending combined integration and
qualification. No compiler, native build, signed install, provider or personal
session ran. Linux, macOS and other Windows architectures refuse. The existing
same-user managed launcher is injectable: native16's execution gate must require
protected SYSTEM-created graph/helper provenance. Images and Job membership
alone must never enable this producer.

This machine-only resource doorway belongs to the separate prospective execution
enrollment and finite command flow. It adds no settings opcode or secret/native
authority to retained read/import consent. The execution owner's local ceremony
and canonical UOA approval remain mandatory. Physical resources prove neither
historical ownership nor original-copy creation; accepted historical baselines
remain unattested.

## Callback and lifetime

`src/t3-session/source/execution.ts` exports
`withT3ExecutionResources({stateDirectory, executorId, admittedRootKey, signal?}, use)`
and `recognizeT3ExecutionResource(scope)`. `stateDirectory` is the startup's
service enrollment reference only: the graph does not open it, load executor
state or receive machine keys. The protected native helper resolves the actual
Windows token's profile using `GetUserProfileDirectoryW`, then only the existing
`.local/state/nessie-executor/<executorId>` source registration. It pins this
owner-only configuration. Service compares its duplicated handle's exact
executor ID, API URL and machine public key with its independently held paired
service enrollment. Missing registration or a different enrollment refuses.
No source configuration or machine key is copied between registrations.

Before opening source DB/settings, a missing or changed linkage requires a
secure-desktop source-owner affirmation. The native prompt displays the actual
registration/source directories, admitted key, owner SID, paired origin and
configuration/public-key fingerprints. It uses six locale translations and
the existing shared OS approval primitive. Service tracks the exact review
helper generation, held configuration and digest; only that fixed protected
native role can confirm after obtaining `AffirmedOwner`. A CLI boolean, daemon
JSON or another helper cannot confirm it. This bounded ceremony is a local
source-registration link, separate from execution issuer/UOA/command authority.

The service-owned `execution-source-links/<executorId>/<SHA256(admittedRootKey)>.json` stores only
product-specific linkage metadata: owner SID, exact configuration identity,
digest/revision, admitted key/actual physical root, executor/public-key digest, paired API origin and enrollment
digest. It stores no homes, keys, profiles or org hierarchy. Replacement or a
different revision/digest/enrollment requires another explicit affirmation;
there is no automatic migration. Observations only cover periods with held resources;
they cannot attest to changes made and restored between scopes. Live resources recheck
both registration and link throughout. Settings are
always `<original stateDir>/settings.json`. Missing, corrupt, over-1-MiB, reparse,
unavailable or non-owner-only settings refuse; absence never creates defaults.

The callback receives `settingsBytes`, `receipt`, `providerReferences`, `signal`
and `recheck()`. Runtime9 alone decodes with `Schema.decodeUnknownSync(ServerSettings)`
from `@nessie/t3-session-source/contracts`; original `ProviderInstanceConfig` and
`ProviderInstanceConfigMap` codecs remain authoritative. The original
`Settings.ServerSettingsService` tag comes from `/engine`. Inspect must not
create the live provider registry or run its startup SecretResolver hydration.
Driver construction and secret resolution require later finite command admission.

Recheck before and after decode, every dependent await, each native/effect phase
and final return. Automatic 20-second physical checks abort on loss without
renewing human/backend authority. Closure invalidates recognition and zeroes
the original byte buffer. Escaped scopes refuse. Never copy/log/serialize/return
settings: original files can contain inline credentials. Buffer zeroing does not
claim to erase every transient V8 JSON/base64 representation.

## Native and service boundary

The fixed `t3-execution-resource` native command calls
`execution_context::authenticate_graph` through the authenticated custody pipe
**before** opening settings/source data. Native16 observes the kernel peer,
protected T3SessionGraph parent generation, supervisor, Job, immutable release
and paired executor. Caller PIDs, markers and descriptors confer no authority.
Every resource/link request additionally calls `require_companion_role(...,
CompanionRole::Resource)`: native16's service creator journal must match the actual
peer generation, immutable release and uncleared fixed resource role. Another
protected companion does not qualify. This function is a separate creator
prerequisite; it is not present in the compiler-qualified parent `7b7ad417`.
After that gate, `allow_execution_pipe_observer` grants `PROCESS_DUP_HANDLE`
only to the actual service SID for this native child.

The native child opens the existing supported actual read-only SQLite resource
and pins settings without write/delete sharing. It internally constructs the
registration from real handles; JavaScript cannot submit evidence or handles.
The service duplicates those objects, never checks one path and opens another.
It checks disk type, file ID, reparse/type state, OS-owner ACL, settings bytes/hash,
persisted environment, configured admission, root and provider-home identities.
Native SQLite main/WAL checks remain in the physical reader. Both retain sticky
namespace/security notifications. Inspect opens no credential/history child.

`windows-common/src/execution_resource.rs` defines private `Authorize`, `ReviewRegistration`, `LinkRegistration`, `Register`,
`Recheck`, `Close` requests. The public `execution-resource.ts` schema contains
metadata only; parsing it issues nothing. Settings travel only to the exact
service-observed graph PID through the private-stdin-key authenticated native
channel. The ordinary daemon's retained reader cannot invoke this opcode.

The service owns duplicated handles under a bounded 55-second lease. Real checks
renew physical lifetime only. A watchdog drops entries after native loss or
expiry even without another request. Explicit close releases service handles
before acknowledgement. Native's 60-second watchdog bounds stuck IPC.

`execution_resource::bind_graph(resource_id, caller, context, graph)` checks the
actual held entry before graph signing and every later finite phase. It matches
source/environment/root, exact provider instance/driver/opaque role references,
and runtime/supervisor/service incarnation. First inspection must be fresh;
later rechecks accept the identical accepted graph digest, without extending
backend authority. Changed same-nonce graphs retire the resource. Runtime/source
writer generations are fixed at first binding for the scope. Native
`resourceGeneration` names this registration only; it is not a writer UUID,
capture generation or historical provenance.

## Original semantics and supported references

Read-only source proof is T3 `25bf84ab07f53f141c20239c63e383823a9d5ea0`:

- `apps/server/src/config.ts:deriveServerPaths` defines `stateDir/settings.json`.
- `packages/contracts/src/settings.ts` and `providerInstance.ts` define original
  instance configs and distinguish unresolved secret references.
- Original `ClaudeDriver.ts` registers `claudeAgent` with `ClaudeSettings`.
  Native settings selection accepts that exact source name and emits `claude`
  only in the execution reference wire. Literal source `claude` is unknown and
  issues no references. `CodexSettings.setupMode` and `shadowHomePath` apply only
  to Codex; `ClaudeSettings` uses `homePath` and has neither field.
- `provider/Drivers/CodexHomeLayout.ts:resolveCodexHomeLayout` keeps continuation
  and history on explicit shared `homePath`, including authOverlay; explicit
  `shadowHomePath` is the credential home when present.
- `provider/Drivers/ClaudeHome.ts:resolveClaudeHomePath` defines explicit homes,
  inherited environment and defaults; this producer supports only explicit
  absolute local Windows paths.

Each opaque reference carries original instance ID, driver, role and actual
directory identity, with no path/value. Aliases may share a physical identity
while references remain distinct. `credential` proves an admitted **home
directory**, not auth.json identity/contents, historical ownership or native
session association. Secret-provider credentials need separate finite admission.
No continuationIdentity is parsed into a path. Managed/omitted/default/env homes
produce no executable refs; explicit missing/relative/tilde/traversal/reparse
homes refuse. No scan, original file change or provider setup occurs.

## Integration and qualification

Native16 public `27649f3efc28b637a58e9820e5017f75095bebd9` defines execution/Custody/Graph
wire; `62f36dd0dfa9dad65a4e6f18ee8cf232c924f104` supplies the refusing protected-process
gate and shared registration. Execution-only transport calls native16's
`spawnProtectedT3Companion('resource')` from `src/t3-protected-process.ts` and awaits
its positive service-cleared `closed` promise on teardown. It never falls back
to ordinary spawn. That SYSTEM creator/facade is a pending separate source
prerequisite; the retained reader keeps its existing direct spawn. Runtime9 owns
the fixed entry and original registry integration.
Root integrates these prerequisites and manifest hunks serially. No sibling
branch was merged or written here.

Authored native cases cover actual bytes/live WAL, simultaneous readers,
pre-existing writers/replacement at waits, original roles, sentinel non-disclosure,
missing/corrupt/oversized/traversal/symlink refusal, real duplicated file identity,
ACL denial, retained-opcode refusal and sticky ACL revocation. TS cases cover
bounded strict metadata and forged callback rejection. All remain unrun.

Receiver component cases use actual duplicated file/ACL/process objects to
exercise retained file locks, environment/digest substitution, expiry and
unlinked-registration refusal. They bypass no production gate and do not
claim positive SYSTEM-created graph admission. A separate wire-only case checks
duplicate roles/objects and bounds; valid wire shape is explicitly not admission.
Native registration cases hold actual configuration/root handles across the review,
dialog and source-open boundaries, refuse replacement, missing admissions and
wrong executors, and verify expiry and overlapping handoff to the SQLite resource.
They never invoke a personal registration or manufacture local affirmation.
Service comparison cases reject mismatched executor, API URL and public key,
missing enrollment identity and cleartext API origins. These are policy tests,
not a substitute for protected service/ceremony acceptance.
The shared `test/t3-session-source/fixtures/execution-settings.json` uses original
`claudeAgent` and `codex` envelopes. A runtime test decodes it with the pinned
ServerSettings, ProviderInstanceConfigMap and both original driver codecs.
The native counterpart substitutes disposable absolute home directories and
verifies all three Claude role refs, exact original instance ID, wire-only
normalization and absence of refs for source `claude`.

Four changed TypeScript modules passed non-evaluating Node builtin syntax
parsing with a 192 MiB heap; `git diff --check` passed. No implementation import,
test suite, compiler or native code was executed.

Parent `7b7ad417588be5472179eb5e1474b76cececc528` adds the resource TS fixture to
`test:t3-physical-source`; root reported locked native/service cargo checks on
that parent. Those compiler results predate the registration link and original
Claude selection correction. Run the exact combined revision in root's reserved
Maxis lane:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=5120'
pnpm exec turbo run build typecheck --filter=@nessie/executor --root-turbo-json=scripts/turbo.public.json --concurrency=1
$env:NODE_OPTIONS = '--max-old-space-size=512'
pnpm exec turbo run test:t3-physical-source --root-turbo-json=scripts/turbo.public.json --concurrency=1
pnpm exec turbo run test:t3-session-runtime --root-turbo-json=scripts/turbo.public.json --concurrency=1
cargo test --manifest-path native/Cargo.toml t3_source -- --test-threads=1
cargo test --manifest-path service-windows/Cargo.toml execution_resource -- --test-threads=1
```

Export coordinated DATABASE_URL per the testing standard; these fixtures use
disposable SQLite/real ACLs. Symlink permission is required with no silent skip.
The separate installed lane must prove protected graph/helper creation, same-user
injection/handle denial, daemon refusal, local+UOA enrollment, inspect without
provider startup, finite execution, expiry/revocation and drained teardown.
