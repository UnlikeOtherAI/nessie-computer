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

User documentation is part of every change, never a follow-up. The consumer
`README.md`, the guides in `docs/wiki/` (published to the GitHub wiki) and the
command reference must describe the current app and CLI; a change to a screen,
a setting, a word or a command updates them in the same pull request, and the
PR republishes the wiki. Screenshots in the README and wiki are retaken whenever
the screen they show changes; they live in the wiki repository's `images/`,
never in this repository. Write all user documentation with the
[Unslop skill](https://github.com/UnlikeOtherAI/nessie-skills/blob/main/skills/unslop/SKILL.md)
and the vocabulary in [the Nessie Computer contract](docs/plans/2026-11-08-nessie-computer.md#2-vocabulary-user-visible-cli-help-uses-the-same-words).

Computer telemetry, provider quotas, native history and human input follow
[computer data](docs/computer-data.md), including their independent viewer cursor and focused checks.
All T3 quota readers, local account sources and bounds follow the [provider quota catalogue](docs/provider-quotas.md).
The daemon doorbell, live session requests, owner answers and `request_secret` follow
[live coding sessions](docs/live-coding-sessions.md); its focused gate is `test:live-sessions`.
Pinned T3 session-engine build inputs and the unfinished runtime boundary follow
[session engine](docs/session-engine.md); `test:session-engine-source` checks source preparation without building native apps.
The generated `/engine` and browser `/client` exports, exact source selection, authored-input registration, shared contract declarations and `prepare:engine`/`test:t3-session-declarations` Turbo gates follow [the package contract](docs/session-engine-package.md).
Completed source generations retain previous outputs and recover bounded Windows rename locks under [package publication](docs/session-engine-package.md#completed-generation-publication); failed generations are preserved.
Bounded source-producer and derived-adapter privacy gates follow [selected runtime construction](docs/session-runtime.md#selected-original-construction-and-codex-host).
The finite browser detail host, original transport factories and account/cache retirement follow [client connection](docs/t3-session-client-connection.md#finite-browser-detail-host).
Retained catalog reads, original operation contracts and their unbound transport/authority prerequisites follow [catalog composition](docs/retained-t3-catalog.md); its render-free gate is `test:t3-session-catalog`.
The callback-scoped captured read graph and signed ordered publication producer follow [retained publication](docs/retained-t3-publication.md); passive graph readiness does not authorize execution.
Original session control, required schedule binding and the render-free `test:t3-session-control-source` / `test:t3-session-control` gates follow [control adapters](docs/t3-session-control.md).
Runtime composition, opaque ProviderHost references, scoped operation slots and the combined qualification gate follow [session runtime](docs/session-runtime.md); its Windows fixtures use the source ACL runner and an external `T3_RUNTIME_FIXTURE_ROOT`, and native/provider producers remain required.
The fixed `t3-session-runtime` entry and existing-daemon inspection channel follow [protected inspection](docs/session-runtime.md#protected-inspection-entry); source inspection never authorizes command/provider input.
Original encoder capture, finite native phase relays and the unbound selected-secret preparation boundary follow [runtime serialization](docs/session-runtime.md#original-encoder-and-finite-native-composition); generic provider stdin remains denied.
The pinned Claude SDK and shared original query runner follow [Claude capture](docs/claude-sdk-capture.md) and [runner composition](docs/claude-original-runner.md); full host activation remains unbound.
Selected original Claude construction and required host owners follow [the Claude host contract](docs/claude-selected-host.md).
The protected launch layer requires the same reservation's [original command recorder](docs/session-runtime.md#original-launch-command-capture); observing creation grants no effect or process authority.
Accepted initial runs and preparation-release predecessors use that same recorder under [preparation lineage](docs/session-runtime.md#accepted-preparation-predecessor); recognition never authorizes an outbox claim.
The original executor's [persisted effect command context](docs/session-runtime.md#persisted-effect-command-context) preserves outbox identity; it never replaces admission before claim.
The protected worker requires a separate [current preclaim owner](docs/session-runtime.md#admission-before-the-original-outbox-claim); scoped row candidates and conditional SQL deadlines are not grants.
Finite native/backend admission for the exact original lease/attempt UPDATE follows [SQL preclaims](docs/t3-execution-preclaims.md); startup/recovery and provider effects require their own authority.
The original lifecycle's five startup/shutdown mutation actions require a separate [current owner](docs/t3-lifecycle-authority.md); refusal still drains providers and never becomes positive clearance.
The Windows tray's bounded inherited-pipe handoff, existing-daemon registry, whole-source capture/publication and drained retirement follow [retained runtime handoff](docs/retained-runtime-handoff.md); no local listener or native execution is added.
The bounded original T3 daemon lane and finite effect-grant verification follow [the lane contract](docs/t3-session-lane.md).
Managed-start target evidence, purpose-bound bridge scopes and legacy/native refusal follow [original session authority](docs/original-session-authority.md).
Explicit T3 root configuration, the Windows held SQLite reader and its unrun native/installed gates follow [physical sources](docs/t3-physical-source.md).
Execution-only held settings, opaque provider homes and the protected graph/service duplication contract follow [execution resources](docs/t3-execution-resources.md); retained read consent grants no execution authority.
Execution SQL uses the native [destination owner](docs/t3-execution-resources.md#native-execution-destination-ownership); writer/file pins grant no pending-row claim or recovery authority.
Its independent [pending-effect reader](docs/t3-execution-resources.md#independent-pending-effect-observation) returns unsigned full-row facts; accepted receipts contain no original parent-command edge.
Unsigned global recovery plans, exact conditional consumption and the independent
held reader follow [process-loss plans](docs/t3-process-loss-plans.md).
A match supplies no lifecycle permission.
The same resource's [original command capture](docs/t3-execution-resources.md#protected-original-command-capture) retains live callback edges and verifies SQL acceptance; its bound observations grant no claim authority.
The fixed `t3-execution secret-observe` companion records terminal environment-slot attempts; secret reads remain unavailable under [prelaunch secret reads](docs/prelaunch-secret-read.md).
Interactive resource confinement, original terminal output and the `test:t3-session-interactive` gate follow [the resource boundary](docs/t3-interactive-resources.md); native/gateway bindings remain required.
Prospective source issuer enrollment, protected local review, online receipt consumption and the unqualified Windows tray/service gates follow [source consent](docs/t3-source-consent.md).

Linux updater images use root-owned immutable libexec paths with the standard SELinux executable label; retain journals and legacy protected images during recovery. See [Fedora service execution](docs/automatic-updates.md#fedora-service-execution).

Windows runtime admission uses its own fixed local pipe; keep pairing-control ACLs and kernel custody proofs separate. See [runtime admission](docs/automatic-updates.md#runtime-admission-and-pairing-control).

The shared AI tab, named ChatGPT profiles and local/LAN inference connections follow
[local AI connections](docs/local-ai-connections.md); use the public Turbo
`test:ai-connections` gate and the local `tray-windows/test/renderer-harness.mjs --only=ai` journey.
Claude Code and Codex offered as engines (the AI tab's On this computer, `ai local`, `local_cli` hosts) follow
[Claude Code and Codex as engines](docs/local-cli-engines.md); its focused gate is `test:cli-engines`.

Team names come from a display-only label in each team's folder, refreshed in one signed batch per server; follow
[team names](docs/team-names.md).

Sessions, concurrent commands, per-command recovery and the opt-in poll follow
[sessions and concurrency](docs/sessions-and-concurrency.md); its focused gate is `test:sessions`.

Standard SDK reporting, release configuration and native limitations follow [error reporting](docs/error-reporting.md).
The focused `test:session-local-pairing` Turbo gate covers shared local bridge
enrollment fixtures under [original session authority](docs/original-session-authority.md).
