# Executor contributor instructions

This public repository owns Nessie's executor source and releases. The private
Nessie control plane consumes a pinned revision; do not add a private repository,
database or server package as an executor dependency. Keep FSL-1.1-ALv2 and
third-party notices intact. Describe the project as fair source / source
available, including its two-year Apache 2.0 conversion.

Work in an isolated worktree and branch. Keep changes focused, commit and push
them, and use a pull request. Merge only after the required checks pass.

Use Node 24, pnpm 10.22.0 and `pnpm verify`. Packaging probes SQLite authorization on the selected runtime; see [runtime requirements](docs/automatic-updates.md#runtime-requirements). Public workspace gates run through
Turbo using `scripts/turbo.public.json`; package tests must retain their build
prerequisites. Windows source tests use the Debug native helper beside an
unmarked Node for real ACL, Job Object and ConPTY checks; ACL transport never
claims installed-runtime authority. Native and installed verification run on their actual OS.
Compiler success does not prove an installed trust boundary.
Session tool schemas, retained metadata projections/navigation, shared input-dependent receipt policy and admission boundaries follow [MCP adapters](docs/session-mcp-adapters.md).
The native coordinator, constrained OS installers and local update policy follow
[automatic updates](docs/automatic-updates.md); use `test:updates` and
`test:updates-native` through the public Turbo graph for their focused gates.
Stable catalogues require Windows, macOS, DEB and RPM together, including Linux detached signatures; preview may contain a complete subset. Catalog publication archives immutable signed bytes before advancing an existing mutable channel; see the same guide.
The shared local Settings/update popup and Linux settings entry have local headless renderer journeys documented there; keep them out of CI. CLI launch checks never hold ordinary commands open.
The macOS signed DMG carries the app and protected runtime; Linux package-publisher rotations also select the Linux native trust check.
Package lifecycle setup, legacy-factory retirement and protected removal intent are machine-only boundaries described in the same guide; preserve their journals and custody inode.
Linux candidate builds verify detached package signatures before recording provenance; unsigned Windows candidates omit the trusted updater service.
Linux archive staging keeps builder ownership for rootless containers; nFPM supplies installed root ownership.
macOS uses the existing Developer ID Application identity, notarized DMG and approved app-bundled helper; follow [that trust contract](docs/macos-update-helper.md).

Public contribution CI has no production signing credentials. Build candidates
separately from publication. Official release signing retains UnlikeOtherAI's
publisher identities and protected release environments. Never publish an
unsigned development artifact or weaken custody to make a fixture pass.

The local console in `packages/executor-console` is shared by Windows and
macOS; Linux local update settings reuse its software section and translations
through `packaging/linux/console`. Reuse it. Every visible change needs all supported translations, a local
headless browser journey and matching before/after captures. Browser and native
UI automation stay out of CI. Manually use every changed capability through its
real entry point before claiming completion.

Read [the security boundaries](SECURITY.md) before changing local permissions,
pairing, native launch, provider credentials or updates. Persist no duplicate
server-side UOA identities or memberships. A local cache never grants access.

Keep code files cohesive and below 500 lines. Understanding natural-language
intent belongs to a model; deterministic code acts on structural protocol facts.
Keep documentation synchronized with implemented behaviour and state concrete
verification limits.

Computer telemetry, provider quotas, owner-only CI, native history and human input follow
[computer data](docs/computer-data.md), including their independent viewer cursor and focused checks.
All T3 quota readers, local account sources and bounds follow the [provider quota catalogue](docs/provider-quotas.md).
The daemon doorbell, live session requests, owner answers and `request_secret` follow
[live coding sessions](docs/live-coding-sessions.md); its focused gate is `test:live-sessions`.
Pinned T3 session-engine build inputs and the unfinished runtime boundary follow
[session engine](docs/session-engine.md); `test:session-engine-source` checks source preparation without building native apps.
The generated `/engine` and browser `/client` exports, exact source selection, authored-input registration and `prepare:engine` Turbo prerequisite follow [the package contract](docs/session-engine-package.md).
Bounded source-producer and derived-adapter privacy gates follow [selected runtime construction](docs/session-runtime.md#selected-original-construction-and-codex-host).
The finite browser detail host, original transport factories and account/cache retirement follow [client connection](docs/t3-session-client-connection.md#finite-browser-detail-host).
Retained catalog reads, original operation contracts and their unbound transport/authority prerequisites follow [catalog composition](docs/retained-t3-catalog.md); its render-free gate is `test:t3-session-catalog`.
The callback-scoped captured read graph and signed ordered publication producer follow [retained publication](docs/retained-t3-publication.md); passive graph readiness does not authorize execution.
Original session control, required schedule binding and the render-free `test:t3-session-control-source` / `test:t3-session-control` gates follow [control adapters](docs/t3-session-control.md).
Runtime composition, opaque ProviderHost references, scoped operation slots and the combined qualification gate follow [session runtime](docs/session-runtime.md); its Windows fixtures use the source ACL runner and an external `T3_RUNTIME_FIXTURE_ROOT`, and native/provider producers remain required.
The fixed `t3-session-runtime` entry and existing-daemon inspection channel follow [protected inspection](docs/session-runtime.md#protected-inspection-entry); source inspection never authorizes command/provider input.
Original encoder capture, finite native phase relays and the unbound selected-secret preparation boundary follow [runtime serialization](docs/session-runtime.md#original-encoder-and-finite-native-composition); generic provider stdin remains denied.
The Windows tray's bounded inherited-pipe handoff, existing-daemon registry, whole-source capture/publication and drained retirement follow [retained runtime handoff](docs/retained-runtime-handoff.md); no local listener or native execution is added.
The bounded original T3 daemon lane and finite effect-grant verification follow [the lane contract](docs/t3-session-lane.md).
Managed-start target evidence, purpose-bound bridge scopes and legacy/native refusal follow [original session authority](docs/original-session-authority.md).
Explicit T3 root configuration, the Windows held SQLite reader and its unrun native/installed gates follow [physical sources](docs/t3-physical-source.md).
Execution-only held settings, opaque provider homes and the protected graph/service duplication contract follow [execution resources](docs/t3-execution-resources.md); retained read consent grants no execution authority.
The fixed `t3-execution secret-observe` companion records terminal environment-slot attempts; secret reads remain unavailable under [prelaunch secret reads](docs/prelaunch-secret-read.md).
Interactive resource confinement, original terminal output and the `test:t3-session-interactive` gate follow [the resource boundary](docs/t3-interactive-resources.md); native/gateway bindings remain required.
Prospective source issuer enrollment, protected local review, online receipt consumption and the unqualified Windows tray/service gates follow [source consent](docs/t3-source-consent.md).

Linux updater images use root-owned immutable libexec paths with the standard SELinux executable label; retain journals and legacy protected images during recovery. See [Fedora service execution](docs/automatic-updates.md#fedora-service-execution).

Windows runtime admission uses its own fixed local pipe; keep pairing-control ACLs and kernel custody proofs separate. See [runtime admission](docs/automatic-updates.md#runtime-admission-and-pairing-control).

The shared AI tab, named ChatGPT profiles and local/LAN inference connections follow
[local AI connections](docs/local-ai-connections.md); use the public Turbo
`test:ai-connections` gate and local `renderer-harness.mjs --ai-only` journey.
