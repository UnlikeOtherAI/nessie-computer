# Executor contributor instructions

This public repository owns Nessie's executor source and releases. The private
Nessie control plane consumes a pinned revision; do not add a private repository,
database or server package as an executor dependency. Keep FSL-1.1-ALv2 and
third-party notices intact. Describe the project as fair source / source
available, including its two-year Apache 2.0 conversion.

Work in an isolated worktree and branch. Keep changes focused, commit and push
them, and use a pull request. Merge only after the required checks pass.

Use Node 22, pnpm 10.22.0 and `pnpm verify`. Public workspace gates run through
Turbo using `scripts/turbo.public.json`; package tests must retain their build
prerequisites. Windows source tests use the Debug native helper beside an
unmarked Node for real ACL, Job Object and ConPTY checks; ACL transport never
claims installed-runtime authority. Native and installed verification run on their actual OS.
Compiler success does not prove an installed trust boundary.
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

Computer telemetry, provider quotas, owner-only CI, native history and human input follow
[computer data](docs/computer-data.md), including their independent viewer cursor and focused checks.
All T3 quota readers, local account sources and bounds follow the [provider quota catalogue](docs/provider-quotas.md).
The daemon doorbell, live session requests, owner answers and `request_secret` follow
[live coding sessions](docs/live-coding-sessions.md); its focused gate is `test:live-sessions`.

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

Standard crash/error SDKs, release configuration and verification limits follow [error reporting](docs/error-reporting.md).
