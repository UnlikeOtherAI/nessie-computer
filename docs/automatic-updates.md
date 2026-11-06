# Automatic executor updates

Status: **not released**. The Windows native installer coordinator and shared
local controls are implemented in source. No signed installed upgrade has been
verified, and macOS/Linux installer adapters and the transition release remain
unfinished. No public update channel is enabled.

The `updater/` Rust crate owns signed catalogue selection, bounded resumable
downloads and the durable installation journal. Its host installer adapters
and authenticated local transport are still being connected. A corrupt complete
download is retained with a `.rejected` suffix and downloaded afresh on retry;
the accepted transaction is retained. Source/development CLIs report an
unsupported updater and never claim to have installed an update.

The CLI entry point exposes `updates status`, `updates check`, `updates install`,
`updates automatic on|off` and `updates remind`, with `--json` for scripts.
Human terminals may offer an available update at launch; JSON output and
internal MCP pipes never receive a prompt. These operations require the
authenticated installed coordinator before they can replace software.

The implementation adds a public software-status contract for signed heartbeats
and a fixed install request containing only a request ID and timestamp. It
cannot choose a download URL, command or update policy. The packaged CLI's
version and source revision are compiled into the signed bundle and included
in its runtime manifest; process environment overrides cannot change them.

Stable installation defaults to automatic. A local opt-out survives subsequent
catalogue checks, downloads, app restarts and upgrades. Opting out keeps version
checks and prompts for a new version with Update now and Remind me tomorrow;
the reminder lasts 24 hours and never suppresses a newer version. Preview
requires an explicit local choice. Remote Nessie teams cannot change this
machine setting.

Settings owns this capability. The executor menu opens it, and Nessie's computer
detail links to those local controls. The CLI must expose the same status and
policy. All visible copy requires the console's seven supported locales.

## Release trust

`src/updates/manifest.ts` verifies the exact Ed25519-signed payload before
interpreting it. It binds a release to its version, source SHA, channel,
monotonic catalogue sequence, validity interval, updater protocol, architecture,
artifact size and SHA-256. Assets name immutable versioned releases in this
repository. Downgrades, same-sequence substitutions, expired catalogues, foreign
URLs and unsupported protocols fail closed. Software publisher validation is
an additional operating-system check, not replaced by the catalogue signature.

The public trust root is `src/updates/public-key.json`. Its private key belongs
only to the protected `executor-updates` environment, restricted to protected
main. Contribution CI receives no signing secret. `packaging/updates/sign-catalog.mjs`
is the machine-only metadata authoring interface via `pnpm exec tsx`; it writes
a new file and refuses to overwrite an existing catalogue. This command does
not validate installed software or authorize publication. Candidate attestations,
platform signing and actual upgrade verification remain release prerequisites.

No catalogue is published until all supported official packages are ready.
Versions advance independently of repository history: the transition release
starts at 1.0.0, above existing 0.0.* Windows builds. Maintain a sequence per
channel in durable local state. A signing-key rotation must first ship a
transition trusted by the old key; replacing the public key alone would strand
existing installations.

## Installation transaction

One native coordinator owns the complete installed payload. Its privileged
interface accepts a fixed operation and a catalogue digest, never a caller's
URL, executable, path or shell command. It does not run privileged Node or
read OAuth profiles, pairing secrets, local folders or team identities.

Windows installs the signed MSI through a constrained privileged helper using
the existing UnlikeOtherAI Azure Artifact Signing certificate profile and
publisher. Builds run on Maxis; the lightweight signing step can reuse the
existing Azure CLI identity on Minis. No private certificate key is copied.
Unattended GitHub signing would need repository-specific federation configured
separately; it is not a prerequisite for signing on Minis. Preserve the UpgradeCode,
service account, state ACLs and publisher. macOS coordinates its signed app and
immutable protected runtime through an approved native installation helper;
updating only the menu app leaves the runtime stale. Linux uses the signed
APT/RPM package transaction. Homebrew installations retain Homebrew ownership.
Never patch an executor inside another signed application bundle.

Check at startup, network recovery and every six hours with jitter. Download
and verify before pausing work. Stop new admission, drain work at an actual
safe checkpoint, retain personal-credential custody fences, independently prove
managed process-tree clearance, and hold the persistent machine admission
barrier during replacement. Do not kill or cancel a running task to install
an update. Restart only connections whose local running switch is still on.
Confirm the new runtime's own version, revision and health before reporting
success.

Journal the exact accepted release and installation phase before replacement.
On interruption or reboot, inspect the actual package and resume that
transaction. Do not discard an incomplete journal to hide an installation
failure. Recovery must not downgrade across a credential-authority floor or
open protected provider profiles to an older process.

## Required verification before enabling a channel

Deploy Nessie's software-reporting API and nullable schema migration before
enabling the public stable channel. The new signed heartbeat includes software
metadata; older control planes can reject unknown request fields. Preview
verification uses the matching private implementation in an isolated instance.

Windows native source now includes a SYSTEM broker and an independent protected
worker. The MSI establishes its root and points SCM at a durable signed image
outside the package being replaced. Normal service recovery restarts it after
failure. Controls accept fixed update operations only; no caller can supply a
path, executable, URL or installer argument. A persistent kernel lock serializes
native runtime creation and replacement. Existing custody records remain owned
and written by the executor service; the updater reads their shared contract.
The broker authenticates its SYSTEM peer, protected image and pinned publisher.

The daemon waits for live command, browser and coding sessions to finish;
inference pauses new claims while active generations finish normally. Automatic
opt-out restores admissions before installation starts. Installation is reported
only after native clearance and a durable journal write. The MSI identity,
version, guard floor, digest and publisher must match, and Restart Manager is
prevented from stopping applications. A fresh native-created daemon with the
new immutable release supplies restart confirmation. Partial installation uses
the surviving trusted worker and original accepted transaction for repair.

The shared local app exposes installed version, automatic installation, Check
for updates and a version-labelled Update button in Settings, including before
pairing. With automatic updates off, its native monitor opens that surface and
the update/remind popup even when the window was hidden. Both native hosts use
the same bounded authenticated coordinator calls as the CLI. Changed copy is
translated into all seven supported locales. The local headless renderer
journey is `node tray-windows/test/renderer-harness.mjs --updates-only`; it is
not a CI job. Matching base screenshots can be captured with
`--updates-before=<base-commit>` from actual Git objects without changing UI.

Windows observes exited generations and empty Job Objects independently of
stale service records; it never deletes that journal or its credential fences
to make progress. Once runtime work is clear, the authenticated native tray
requests permission to exit. The SYSTEM broker records its real account,
interactive session and process generation, and restarts only the installed,
verified tray as that user. It never starts Node as SYSTEM for a health check.
Restart confirmation requires a new daemon when the drained installation had
one. An installation with no running daemon instead exercises the exact signed
native helper's compiled version, revision and protocol. App restart records
remain until the new app is alive and health is confirmed; opt-out resumes the
same installed app. These paths still need actual signed installation tests.

Direct local inference and personal-plan credential actors stop accepting new
claims, finish active generations and leave through normal cleanup. An
intentional personal-plan restart stores only a target version and operation
reference in its existing owner-only metadata. The native app's normal status
interface can resume that previously granted profile through the current
factory, repeating pairing authority and custody checks. Registration, account
generation, consent, encrypted credentials and unsettled receipt keys remain
intact; a disconnect or revocation prevents resumption.

macOS and Linux installer adapters remain disabled until their native package,
publisher and clearance paths are implemented and verified. The macOS controls
still need a native compile and app exercise. The Desktop transition to the
independent runtime and all-platform signed installed acceptance are unfinished.

The coordinator persists check deadlines and bounded retries separately from
installation progress. An accepted transaction resumes through catalogue
outages and expiry using its originally verified signed bytes. Kernel-owned
worker and journal locks recover after process exit; network calls never hold
the preference lock. A concurrent local opt-out survives every progress write.
An explicitly selected newer signed release can recover a failed transaction;
its predecessor, failure code and request remain archived, and native fences
stay authoritative until replacement and fresh health are verified. Expired
catalogues do not hide the installed version or block local policy changes.
Manual requests join the current transaction and never authorize an unrelated
future release. Corrupt downloads are retained for diagnosis before a fresh
attempt. CLI launch checks are bounded and human-terminal-only, with the same
supported languages as Nessie. The pending target version remains visible
after package replacement while fresh runtime confirmation is outstanding.

`nessie-executor updates` supports `status`, `check`, `install`, `remind`,
`automatic on`, `automatic off`, `channel stable` and `channel preview`, with
`--json` for machine-readable status. Channels are fixed vendor origins; a
remote Nessie request cannot change them. Stable is the default. Channel changes
wait until an accepted installation finishes; they cannot retarget its package.

Use the actual signed installed package on Windows, macOS and Linux. Exercise
automatic installation, persistent opt-out, popup and reminders, explicit
update, active work, offline recovery, interrupted installation and reboot.
Check pairings, folder permissions, local provider custody, service identities
and the persistent admission inode before and after. Reject modified metadata,
wrong publishers, wrong architecture and incompatible protocols through the
same real interface. Browser journeys and matching screenshot evidence apply
when the console changes. No installed flow is claimed by the current unit
tests or native compilation.
