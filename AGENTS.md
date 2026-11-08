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
prerequisites. Windows state tests require the real native ACL helper beside
their test Node. Native and installed verification run on their actual OS.
Compiler success does not prove an installed trust boundary.
The native coordinator, constrained OS installers and local update policy follow
[automatic updates](docs/automatic-updates.md); use `test:updates` and
`test:updates-native` through the public Turbo graph for their focused gates.
The shared local Settings/update popup has a headless `--updates-only` renderer journey documented there; keep it out of CI.
The macOS signed DMG carries the app and protected runtime; Linux package-publisher rotations also select the Linux native trust check.
Package lifecycle setup, legacy-factory retirement and protected removal intent are machine-only boundaries described in the same guide; preserve their journals and custody inode.
Linux candidate builds verify detached package signatures before recording provenance; unsigned Windows candidates omit the trusted updater service.
macOS uses the existing Developer ID Application identity, notarized DMG and approved app-bundled helper; follow [that trust contract](docs/macos-update-helper.md).

Public contribution CI has no production signing credentials. Build candidates
separately from publication. Official release signing retains UnlikeOtherAI's
publisher identities and protected release environments. Never publish an
unsigned development artifact or weaken custody to make a fixture pass.

The local console in `packages/executor-console` is shared by Windows and
macOS. Reuse it. Every visible change needs all supported translations, a local
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

Computer telemetry, Claude/Codex account probes, native history and human input follow
[computer data](docs/computer-data.md), including their independent viewer cursor and focused checks.
The daemon doorbell, live session requests, owner answers and `request_secret` follow
[live coding sessions](docs/live-coding-sessions.md); its focused gate is `test:live-sessions`.
Pinned T3 session-engine build inputs and the unfinished runtime boundary follow
[session engine](docs/session-engine.md); `test:session-engine-source` checks source preparation without building native apps.
The generated `/engine` package export, exact authored-input registration and its `prepare:engine` Turbo prerequisite follow [the package contract](docs/session-engine-package.md).
Runtime composition, opaque ProviderHost references, scoped operation slots and the combined qualification gate follow [session runtime](docs/session-runtime.md); native/provider producers remain required.
