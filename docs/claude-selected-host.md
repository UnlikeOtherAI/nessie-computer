# Selected original Claude host

The selected registry now constructs the actual original Claude adapter and
binds its existing query-runner tag to the protected SDK runner. This is a
machine-only composition prerequisite. Production `open` still refuses while
the real host owners and their authority remain incomplete.

## Shared implementation

Extraction derives `ClaudeAdapterV2.session-live.ts` from the pinned original
adapter. It excludes the application process launcher, process-group helper,
history worker and protocol logger. Original turn, request, attachment, skill,
subagent and continuation behavior remains in the adapter. Request privacy is
applied to both application and derived bytes after extraction.

The original configuration and skill libraries move to `provider/ClaudeHome.ts`,
`ClaudeSkills.ts` and `ClaudeSkillDispatch.ts`. Their former `Drivers/` paths
reexport those same implementations. The application and selected host therefore
share the original environment merge, settings reads, skill discovery and skill
dispatch. The source policy still excludes driver constructors, maintenance and
application host aggregates; no exception was added for the old directory.

`makeClaudeInstance` shares the original instance assembly. The application driver
retains its existing cache invalidation, workspace probe and reset-credit methods.
Selected construction supplies the actual orchestration adapter, snapshot and
text-generation services without starting application maintenance or probes.

## Required owners

`SelectedClaudeServices` requires the real selected instance's snapshot,
text-generation service, model catalog and scoped limit-name Ref. No service
implementation, synthetic readiness or default text generator is supplied.

`SelectedClaudeDriver` retains the original environment merge and Claude-home
selection. An absolute Windows EXE and explicit configured home are required;
PATH, script launchers and default-home resolution refuse before effect-host
acquisition. Native still must hold and independently match the actual image and
home before hashing its launch payload. A path check is not that evidence.

Configuration and skills use the original `FileSystem` service. The original
adapter also requires `ChildProcessSpawner` for attachment conversion. These must
be actual admitted owners; no Node host layer or generic process facade is bound
by this implementation. Source reads, attachment conversion and workspace effects
do not gain permission from a reserve or FRAME receipt.

`createSessionSelectedProvider(plan, launch)` retains Codex's independent host
requirements. `createSessionSelectedClaudeProvider(plan, launch, history)`
requires the real `SessionClaudeHistoryOwner` and binds the protected runner.
Both consume the existing opaque plan's private empty-reference environment
through the same internal constructor checks. They recheck the exact selected
target and settings, permit one construction attempt and return the original
registry view. Missing Claude history refuses; there is no SDK fallback.
Nonempty plans still require the safe native secret-read producer.

The original adapter configures host callbacks before provider input. The
protected runner continues to reject unbound callbacks and SDK/stdio MCP hosts
before startup. This tranche does not remove those callbacks, replace their
results or enable a smaller bootstrap-only production path.

## Build and provenance

The complete original adapter reaches `diff` 8.0.3 and `yaml` 2.9.0. Both versions
and registry integrities match the pinned upstream lock. The source package,
isolated producer and private consumer locks retain those exact records without
changing existing dependency or peer bindings. Diff is bundled; YAML stays an
exact declared runtime dependency so Node loads its original CommonJS entry.
The normal library build records both dependency identities and licenses.

Esbuild labels JSON inputs with `with { type: 'json' }`. Both producer paths now
resolve that exact metadata decoration to the existing pinned JSON file before
hashing. Unknown decorations, absent files and JSON attributes on TypeScript
inputs refuse. The original source and import site remain in provenance.

## Verification

Use the public Turbo gates on Maxis with an isolated `DATABASE_URL` exported:
`test:session-engine-source`, `test:t3-session-engine`,
`test:t3-session-runtime` and `test:t3-session-requests`.

The focused cases check the actual shared assembly, selection refusal before
host access, original application/derived privacy canaries and normal packaged
JSON/dependency provenance. Synthetic service references in assembly fixtures
prove reference preservation only. They do not supply a production host owner.

Actual enrolled construction, a real Claude turn, source withdrawal, native
association, history and signed installed clearance remain separate acceptance
work. Full activation, lifecycle/recovery authority, MCP credentials,
configuration/attachment effects and post-association writes remain unfinished.
