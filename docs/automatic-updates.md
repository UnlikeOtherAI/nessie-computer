# Automatic executor updates

Status: **preview published; stable acceptance incomplete**. Immutable release
[1.0.12](https://github.com/UnlikeOtherAI/nessie-executor/releases/tag/executor-v1.0.12)
contains signed Windows x64 MSI, Apple-silicon DMG and Linux x64 DEB/RPM packages
from `e799a7aa3dc53d8430a925ba3027b2039adca7ae`. Anonymous downloads matched
all recorded hashes and sizes on 8 November 2026, including both Linux detached
signatures. The protected publisher produced preview catalogue sequence 2;
its Ed25519 signature and exact match with the immutable archive were verified.
It was issued at `2026-11-08T07:32:08.234Z` and expires thirty days later.
The complete stable channel is not enabled. Its legacy sequence-1 catalogue
still contains only the 0.9.1 Apple-silicon DMG.

The original signed Windows 1.0.12 MSI installed successfully on Maxis. Its
machine-PATH CLI passed ordinary desktop-token version/source, policy readback,
Check and invalid-action exit-code checks. FedoraMaxis installed the signed
1.0.12 RPM with SELinux enforcing; the updater is active with zero restarts.
The installed GNOME application opened through its packaged entry, showed
1.0.12, saved automatic off, requested Check and restored automatic on.

Finder installed the signed 1.0.12 app on Dictator. The protected factory still
reports 0.9.0 at `879a601`; app copying alone does not replace that factory.
The new preview superseded its retained 0.9.1 transaction with 1.0.12, preserving
the transaction history and custody records. Runtime clearance and a coordinated
restart remain pending. Immutable preview 1.0.13 now covers all four formats at the same source, with
preview catalogue sequence 3 and verified anonymous package hashes.

Windows completed a catalogue-driven automatic 1.0.12-to-1.0.13 upgrade on
Maxis, including fresh native runtime confirmation and the new CLI. Signed APT
repository install/upgrade/removal passed for the same versions in a bounded
rootless Bookworm container, preserving user state and the custody inode; that
container does not claim a live updater. Fedora showed the real opt-out offer
and saved a reminder from 8 November 08:06:26.966 UTC until exactly 9 November
08:06:26.966 UTC. Closing/reopening Settings retained the reminder. A short
ordinary TTY command completed without waiting for its launch check.

The Fedora interruption test requested a normal guest reboot while 736,640 of
67,686,560 RPM bytes were present. Its accepted transaction and custody inode
survived, but installation remains waiting. Investigation found that private
account scanning refused unrelated group-writable system runtime homes. The
source correction below still needs a signed installed retry. Notification,
explicit Update, reboot recovery, retained pairing/reconnect and post-upgrade
provider requests remain release prerequisites on their unverified platforms.

The Mac distribution reuses its existing Developer ID
Application identity and notarized DMG, with an approved app-bundled native
background helper. See [the helper trust contract](macos-update-helper.md).

Local signed candidates 1.0.2 and 1.0.3 now exist for all four formats at
`a24bd9c2bf40201693baa1ddca9ffb7713619d2c`: timestamped Azure-signed Windows
MSIs, Developer ID signed/notarized/stapled Apple-silicon DMGs, and signed
Linux DEB/RPM packages and repository metadata. Those earlier candidates remain unpublished and were superseded by the
1.0.12/1.0.13 candidates above; they do not establish installed A-to-B acceptance.

Signed local candidates exist on Windows, macOS and Linux. Windows 1.0.11
at `9d8fef9` installed normally on Maxis; its non-elevated controls can read
status, change and restore the automatic preference, and request a check. The
SYSTEM worker completed its first catalog check and returned idle with no
recorded failures. Its managed CLI passed under the non-elevated desktop token
and passed again after a normal SCM service restart. The runtime admission
transport no longer requires a legacy pairing-control grant.
Earlier notarized macOS candidates passed signature and Gatekeeper checks;
the current installed-app/protected-factory distinction is recorded above. Fedora's signed 1.0.2 package has passed service recovery and a
machine restart. None of these candidates establishes stable A-to-B acceptance.
macOS signing uses the existing GUI session and Developer ID identity; no
additional Installer certificate or account setup is required.

The Windows MSI producer requires Node 22 and supplies the selected numeric
release version to the packaged CLI as well as to the installer and native
helper. A development-labelled bundle is not a release candidate.
Unsigned Windows source candidates omit the SYSTEM updater service and its
setup/removal actions. Their MSI records update protocol `0`; a signed build
records `1`, and both publication inspection and the production updater reject
packages without that floor.
This keeps candidate installation independent of production credentials while
retaining publisher verification for protected setup and every real update.

macOS release construction supplies that version to its native helper, CLI
bundle and application Info dictionary. The signed DMG includes the sealed
runtime and fixed app-bundled native service. Apple owns its one-time administrator
approval. The native adapter verifies the DMG publisher and Gatekeeper before
mounting it readonly, then validates a private copied app before replacement.
Unsigned candidates remain explicitly labelled and cannot be installed.
The menu-app Xcode build uses two jobs and passes the numeric release version
as its marketing/build settings before the installer checks its identity.

The `updater/` Rust crate owns signed catalogue selection, bounded resumable
downloads and the durable installation journal. Its host installer adapters
and authenticated local transport are still being connected. A corrupt complete
download is retained with a `.rejected` suffix and downloaded afresh on retry;
the accepted transaction is retained. Source/development CLIs report an
unsupported updater and never claim to have installed an update.

The CLI entry point exposes `updates status`, `updates check`, `updates install`,
`updates automatic on|off` and `updates remind`, with `--json` for scripts.
Human terminals start an unreferenced background check at launch. An available
version prints the fixed `updates install` and `updates remind` actions without
reading standard input or holding an ordinary command open. A short command may
finish before the check responds; the native coordinator retains its check.
JSON output and internal MCP pipes never start a launch offer. These operations require the
authenticated installed coordinator before they can replace software.

The implementation adds a public software-status contract for signed heartbeats
and a fixed install request containing only a request ID and timestamp. It
cannot choose a download URL, command or update policy. The packaged CLI's
version and source revision are compiled into the signed bundle and included
in its runtime manifest; process environment overrides cannot change them.

Stable installation defaults to automatic. A local opt-out survives subsequent
catalogue checks, downloads, app restarts and upgrades. Opting out keeps version
checks and prompts for a new version with Update now and Remind me in 24 hours;
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
not validate installed software or authorize publication.
`packaging/updates/compose-catalog.mjs` builds the unsigned manifest from the
packages already attached to `executor-v<version>`, hashing the downloaded bytes;
it maps the versioned Windows x64 MSI, Apple-silicon DMG, Linux x64 DEB and RPM
and each Linux package’s detached `.asc` signature. Linux packages and signatures
are inseparable. Stable composition requires all four targets; preview can select
a complete subset. Unknown files, foreign versions and empty assets are
rejected. The manual `Publish Update Catalogue`
workflow runs both commands in the `executor-updates` environment on main and
checks that the release tag resolves to the supplied source revision, and
replaces `catalog.json` on the channel's `update-catalog-<channel>` release. It
downloads the Linux detached signatures with their packages. Candidate attestations,
platform signing and actual upgrade verification remain release prerequisites.

A new stable catalogue must not be published until all supported official
packages are ready.
The existing Mac-only sequence-1 catalogue is incomplete; the composer now
rejects that shape for stable publication. Preview retains single-platform
composition for bounded installed verification.
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

A drain is a bounded attempt. A waiting transaction holds new admissions for at
most one hour, then reopens them for six hours before the next attempt; nothing
running is stopped. Replacement is offered only inside an attempt window, and
`installing` and `restarting` keep the fence. A downloading or waiting
transaction whose version the installed runtime already meets (for example, a
newer Mac app installed its own runtime) is archived under `updates/retired/`
and its drain ends. See [recovering a stuck helper](macos-update-helper.md#recovering-a-stuck-helper).

Journal the exact accepted release and installation phase before replacement.
On interruption or reboot, inspect the actual package and resume that
transaction. Do not discard an incomplete journal to hide an installation
failure. Recovery must not downgrade across a credential-authority floor or
open protected provider profiles to an older process.

## Required verification before enabling a channel

Run `cargo test --manifest-path native/Cargo.toml` in the Linux package builder
before producing a candidate. This includes interrupted workspace-promotion
rollback after an earlier journal scan and repeated directory enumeration.
These source checks do not establish installed update acceptance.

Linux staging verifies the pinned Firecracker archive and extracts it without
restoring upstream file ownership. nFPM assigns installed root ownership. The
same producer supports rootless build containers without mapped upstream UIDs.

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
For reminder and retry copy, add `--updates-copy-only` to both runs; it visits
only the changed offer and service-unavailable states.

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

macOS and Linux installer adapters are being connected in source; they have
not passed installed acceptance. The existing Mac-only catalogue does not
establish their acceptance. The macOS controls
passed a native Swift typecheck at `489c3c3`; app exercise remains unverified.
The macOS menu bar and Desktop now select the fixed installed `current` factory
rather than the executor digest embedded in their app bundle. A sealed Developer
ID app declares launch protocol `1`, personal-inference guard `2` and independent
runtime consumption in its signed Info dictionary. The native helper validates
these through Code Signing Services; an older or modified app remains refused.
Windows/Linux Desktop transition and all-platform signed installed acceptance
are unfinished.

Unix native creation rechecks the selected release while retaining the existing
machine admission inode. Root-owned update maintenance state pauses new daemons,
direct hosts and credential actors during draining, and admits only the verified
replacement digest while restarting. Native worker and broker lifetime leases
are separate from the coordinator's per-tick lease, so a service restart can
reuse a surviving worker without starting competing retry loops. The Unix
socket, protected worker cache and system-service setup are staged in source;
their installer/health adapters are not accepted yet. The macOS
custody package now carries the `current` symlink its consumers select.
An installed but incomplete macOS factory is kept as the launch target so a
partial replacement cannot silently fall back to the app's older bundled Node.

On Linux, a real systemd host enables and starts the updater unit. A container
or offline image without systemd as PID 1 only enables the unit for a later
host boot; it does not claim that a coordinator is running or gain personal
credential eligibility.

Unix adapters use the existing machine lock, all-account public native journals
and two kernel inventories. A current-boot orphan remains a blocker; the updater
does not erase custody evidence. Restart health challenges the retained native
parent and confirms the new daemon's actual process generation. A stopped or
unpaired installation instead executes the exact new native helper's compiled
build information. Linux additionally verifies the pinned package publisher in
`packaging/linux/keys`; macOS checks the Developer ID Application publisher,
Gatekeeper, sealed app floors and runtime version/source. Initial retirement of legacy creators and installed package
recovery still need completion before release.
The Linux repository producer emits `<package>.asc` for both DEB and RPM with
the same signing key as repository metadata. Candidate hashes and `SHA256SUMS`
include these detached signatures, and publication requires their exact bytes.
Verification-key builds retain their explicit non-publishable signing mode.
The package workflow verifies both detached signatures before recording candidate
provenance. Its container install fixture explicitly installs `util-linux` for
the unprivileged `runuser` check, including on minimal Fedora images.

Package removal now writes a protected disable marker before stopping the
updater. Accepted bytes, replay floors, local update preferences and credential
fences remain intact; a surviving worker cannot reinstall the removed package.
Major upgrades skip removal intent. Windows removal rollback and package repair
reenable the restored installation; Linux reinstall runs the same protected
setup. Actual removal/rollback testing is still pending.

Unix release manifests declare update-admission protocol `1`. On the initial
transition, the protected worker waits for whole-machine clearance and removes
user read/execute permission from legacy native creators, runtimes and bundles,
retaining their exact bytes for audit or repair. It preserves the existing
machine lock and public custody journals. New actors remain fenced until that
step finishes. Later releases enforce selected-current and maintenance state
themselves. The first transition requires older executors to finish and close;
the installer does not terminate their work. This path needs installed testing.
The local Settings page explains this initial wait in all supported languages
and removes the message when setup recovers. Its focused headless journey is
`node tray-windows/test/renderer-harness.mjs --updates-bootstrap-only`; add
`--updates-before=<base-sha>` for matching base-revision captures. These checks
exercise the shared Windows/macOS renderer with broker fixtures, not an installed
bootstrap. The 440/640-pixel states and all seven locales passed on Maxis.

The macOS menu app now requests a native handoff once runtime work is clear.
The Root broker records the actual app and agent process generations. A retained
same-user native agent waits while the app is replaced, then opens only the
publisher-verified fixed installed app after the replacement is admitted.
It does not run Node as Root. Completion also requires a new verified app
generation. The menu app remembers each connection's local running switch;
an update or app reopen must not start a connection the person stopped.
These handoff and late-stop paths still need signed installed acceptance.

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

## Fedora service execution

Protected Linux updater images live at
`/usr/libexec/nessie-executor-updater/<sha256>/nessie-computer-updater`.
They remain root-owned, readonly and hash-verified, outside the package contents
being replaced. Journals, preferences and the custody barrier stay under
`/var/lib/nessie-executor`. On SELinux hosts the native producer restores the
image's standard executable context before systemd starts it; packages depend
on `policycoreutils`. No custom permissive policy or disabled enforcement is needed.
A surviving legacy protected image is verified before copying it to libexec when
current package files are incomplete; accepted transactions and old bytes remain.

The installed Fedora 1.0.0 candidate at `65f0cca` exposed systemd exit 203/EXEC:
its protected copy inherited `var_lib_t` under the state directory. Its package
signatures and CLI version passed, but the updater was unreachable. That candidate
is retained for failure evidence and is not a published release or accepted
A-to-B baseline. Verify recovery through a corrected package with SELinux enforcing.

Installed correction verified on FedoraMaxis at `f0a6085`: signed RPM 1.0.2
replaced the failed 1.0.0 candidate through DNF. The existing systemd service
recovered without journal edits or a manual service restart. Its libexec image
has `bin_t`. After a full VM reboot, the updater returned active with zero
restarts; the ordinary installed CLI reported 1.0.2, `canInstall: true` and
automatic/stable defaults with SELinux still enforcing. The root-owned legacy
image remains. Packaging-plan tests and all 37 native Rust tests passed.
This verifies service setup and restart recovery, not catalogue-driven A-to-B
installation, notification, interrupted-transaction recovery or GNOME controls.

## Linux local settings

The DEB and RPM payloads include `nessie-executor-app` and the Nessie Executor
application entry. Its WebKitGTK window renders the same Software updates
section, translations and Update / Remind me in 24 hours dialog as the Mac and
Windows console. It shows the installed version, automatic preference, Check
for updates and Update action before a team is connected.

A desktop autostart entry monitors the authenticated updater in the user's
graphical session. With automatic updates off, a newly available version opens
the shared offer even after the window was closed. The reminder waits exactly
24 elapsed hours, including across daylight-saving changes; it never promises
the next calendar day. The reminder lives in the
native coordinator, so closing or restarting this app cannot erase it. After
the installed version changes, the fixed package launcher reopens the new
console. Root-owned update and pairing state stay with their existing owners.

The unprivileged Python/GTK host exposes no listener. It loads only its packaged
document, blocks remote navigation and web permissions, and maps a strict local
request to fixed `nessie-executor updates` arguments. The page cannot select an
executable, file, URL, channel or environment. GTK and WebKit are OS package
dependencies; no Python package download occurs at app launch.

Focused native protocol checks run on Fedora with
`python3 packaging/linux/test/console_test.py`. The local headless renderer
journey is `node packaging/linux/test/renderer.mjs`; keep it out of CI.
The installed GNOME entry and policy/check readback passed on FedoraMaxis with
signed 1.0.12. Notification, reminder and catalogue-driven reboot recovery remain
release acceptance work.

## Windows source verification context

Build the Debug helper with `cargo build --manifest-path native/Cargo.toml`.
The Windows source runner places Node beside that helper for real DACL, Job Object
and ConPTY checks. Release Job/terminal helpers require an installed signed factory;
the source terminal driver selects only Debug, and source tests do not claim
that factory. Public
ACL operations use that fixed sibling without marking Node as an installed
executor. Previously the runner set `NESSIE_EXECUTOR_PACKAGED_CLI=1` solely to
reach the helper; that also activated installed-only custody and stranded source
MCP teardown on proof the uncontained test process could not provide.

The ACL transport and runtime admission are now separate. State-test prerequisite
checks use the sibling helper, so unmarked source runs retain real DACL coverage.
State-store and guest-runtime fixtures set actual Windows DACLs in that context;
POSIX chmod is never treated as Windows privacy.
Guest artifact tests still require installed package resources. A missing or symlinked
helper still refuses; there is no PATH search or helper environment override.
Installed-only updater and credential commands retain their own package, publisher
and native factory requirements. The real Windows regression verifies owner-only
state while update installation is unsupported and native credential context is
rejected for the source runtime. Existing journals and unknown-stop fences are
never cleared to make source tests pass.

Run the focused source/ACL/bridge, secret-delivery, Job Object and terminal regressions through Turbo with
`pnpm exec turbo run test:windows-source --root-turbo-json=scripts/turbo.public.json --concurrency=1`.
Then run `pnpm verify`; installed acceptance remains a separate gate.

## Immutable catalog history

Versioned installer releases must be published with GitHub release immutability
enabled. The publisher checks each downloaded package and Linux detached
signature against that immutable release's GitHub SHA-256 digest and size. Its
source tag must match the declared revision, which needs a successful CI push
on protected main. OS signing and installed acceptance remain separate release
requirements; a GitHub digest does not replace them.

The protected catalog workflow first publishes the signed envelope as
`update-catalog-<channel>-<sequence>`, an immutable release at the same source
revision. Only after rereading its exact bytes does it replace `catalog.json` on
the existing mutable `update-catalog-<channel>` release. Those two moving
channel releases predate repository immutability; the publisher refuses a
missing or immutable moving channel instead of creating a frozen destination.

If upload stops after archival, repeating the same request reuses the archived
signature and bytes, including an already uploaded draft. It cannot change that
sequence's version, source or package inventory. The signed current catalog
supplies a replay floor even after its validity expires; candidate validity is
always checked at the actual publication time. A rollback, substituted current
payload, changed package or expired archived candidate refuses publication.
A fresh higher sequence is required to renew expired metadata.

`test:updates` includes the publication recovery, integrity and 24-hour reminder
boundaries across London daylight-saving changes.
Catalog history uses GitHub release attestations generated by immutable
publication; it does not claim the legacy CLI builder's artifact attestations.

## Windows CLI entry point

The MSI installs `nessie-computer.cmd` and, under the older name,
`nessie-executor.cmd` beside its native launcher and registers that protected
directory in the machine PATH. Both are the same wrapper. New terminals can use
`nessie-computer settings updates --json` and the ordinary CLI commands. The wrapper
passes arguments to the fixed native managed-runtime entry; it never invokes an
ambient Node binary, selects an update origin or supplies credentials. Windows
Installer owns PATH registration and removes it on uninstall. Installed 1.0.12 passed command discovery through machine PATH, ordinary-user
argument handling and invalid-action exit code. Launch-notification acceptance
remains pending; the prior edge MSI exposed no `nessie-executor` command on Maxis.

## Windows installed setup and rollback

The signed MSI uses the existing UnlikeOtherAI Azure Artifact Signing identity.
Major upgrades remove the old product inside the MSI transaction, after
`InstallInitialize`; failure restores the old product. Installed tests must use
the original signed MSI. A transform may inject a failure only in a separate
rollback test, and that result is not an ordinary installation pass.

Before any file changes, the MSI closes what runs from the install folder
besides the service, which it stops itself: the Windows app in each session,
and team daemons a scheduled task or a terminal started. Files replaced under
running processes failed the install with 1603, and the rollback queued
reboot-time file swaps that undid the next install. `--close-for-install` runs
from the package's own Binary-table copy of the service, so the new code runs
while an older release is installed. It is an immediate action before
`InstallValidate`: the upgrade removes the previous product at
`RemoveExistingProducts`, straight after `InstallInitialize`, and Windows
Installer fails an upgrade with error 2613 (1603) when any script action comes
ahead of it. `installSequenceProblems` in `packaging/windows/msi-plan.mjs` checks
that rule against the authoring. As an immediate action it runs as the
installing account, SYSTEM for an automatic update. An account that cannot
write the service's note of the closed apps (a manual install) still closes
them, and the app opens at the next sign-in instead of straight after the
install. A Windows app from this release quits when
the install event is set, and its daemons stop as their liveness pipes close.
Other daemons get Ctrl+Break on their own console, which this release's daemon
treats as a graceful stop. Whatever still runs after 30 seconds is terminated
(the app after six). The action refuses with `install_handover.still_running`
before any file changes if something survives that. `--reopen-after-install`
reopens each closed app in its own session, for the person signed in there,
after the service starts again. A failed install does not reopen them: a
rollback action would run before the previous release's files are restored. The
restored service starts again, and the app at the next sign-in.

The setup custom actions (`--secure-state-root`, `--secure-updater-root`,
`--disable-updater-for-removal`) keep only an exit code in the MSI log, so a
refusal is also written to the Windows Application event log under the source
`Nessie Computer Setup`, as one line led by a stable code: for example
`updater_setup.helper_refused helper=update.installed_tray_unverified exit=1`.
`helper=` is the native helper's own code. `update.installed_tray_unverified`
and `update.installed_service_unverified` mean that file in the release folder
is not the one the new manifest names. A Windows app still running from the
previous install causes the first: Windows Installer replaces a file in use only
at the next restart. Read it with Event Viewer, or in Windows PowerShell:
`Get-WinEvent -LogName Application -FilterXPath "*[System[Provider[@Name='Nessie Computer Setup']]]" -MaxEvents 5`.
The line carries codes only, never a path, key or child-process output.

The native protected-image pin requests READ_CONTROL for its retained handle.
Creator-owner inheritance-only ACEs do not grant access to the parent; actual
files remain independently checked. SYSTEM installer setup may run in the active
logon session, while live updater and worker roles still require SYSTEM/session 0.
SCM recovery setup requests SERVICE_CHANGE_CONFIG and SERVICE_START. A real
one-off test service verifies its failure actions without starting an executable.

The signed 1.0.4 candidate at `2fcf592` passed a forced-failure rollback test:
MSI restored the previous installed edge product, service and pairing. That test
did not validate stable automatic updates. The signed 1.0.11 candidate at
`9d8fef9` subsequently passed the normal installer, timestamped publisher/EKU
verification, both automatic services, non-elevated update controls and a
background catalog check. Its managed CLI passed before and after a normal SCM
service restart. Its native gates passed 39 common, 31 native, five integration
and 58 service tests on Maxis. Its MSI SHA-256 is
`315c2e7307a46b65838321c48bcf6f4b5a1b87eb70e186e8827f568b598f5480`
and size is 50,593,792 bytes. It remains unpublished.

Nonblocking broker reads preserve Win32 ERROR_NO_DATA rather than Rust's EOF
mapping. ConnectNamedPipe returning TRUE means the server is listening; only
ERROR_PIPE_CONNECTED establishes a client in PIPE_NOWAIT mode. Real kernel pipe
tests cover empty, connected, request/reply and disconnected states. The
restricted worker environment includes OS-derived SystemRoot, SystemDrive,
ALLUSERSPROFILE and ProgramData. No caller environment override selects the state
root. The admission marker is read through the retained locked handle because
Windows mandatory locks reject a second handle; the journal and inode survive
recovery unchanged.

### Runtime admission and pairing control

Both pipes have independent worker limits and request/reply deadlines; saturation
expires without stopping the service. See [runtime durability](runtime-durability.md)
for the lifetime contract and Windows fixtures.

The pairing/control pipe `\\.\pipe\NessieExecutor` retains its existing
Administrators and explicitly approved-account ACL. User-owned connections do
not need a legacy service pairing or a repair grant to start. Their signed native
launcher uses the separate fixed local pipe
`\\.\pipe\NessieExecutorCustody`. This transport admits authenticated local
accounts with client read/write rights only: no rival-instance creation and no
remote clients. It accepts only managed-custody operations. Status, pairing,
enrollment, folder grants and daemon-control requests cannot reach the legacy
control handler through it.

The same service custody handler still proves the live native producer's
publisher, immutable release, account, session, child generation and named Job
Object before registration. Machine-only runtime roles retain their service
account and session-zero checks. Credential fences and update admission remain
mandatory. Opening a pipe never grants custody.

Both service roles publish only the process identity/liveness and token query
metadata their clients require. The native launcher and suspended child grant
those same read-only facts to the Windows-derived service account so the service
can verify them. Existing ACL entries are merged, not replaced. No terminate,
memory, handle duplication, token impersonation or ACL-write right is added.

The runtime-only channel and reciprocal metadata fix passed the signed installed
CLI journey, including service restart, without a control grant or Repair. The
full native app, computer reconnect and machine-restart upgrade journeys remain
unverified. Existing user pairings, service grants, accepted work and
update/custody journals remain intact.

The read-only developer probe is:
`cargo run --manifest-path windows-common/Cargo.toml --example update-status`.
It uses the authenticated fixed updater pipe and reports closed failure stages,
OS errors and bounded byte counts. `--peer-facts` independently reports updater
process/token, publisher and protected-image observations. `--installed-facts`
checks known-folder and release provenance without changing state.
`--service-peer-facts` inspects the fixed runtime service pipe without sending
companion proof or a command. Diagnostic output never establishes health,
authorizes installation or bypasses authentication.

## Account state during native clearance

Unix custody inspection first establishes whether an account owns a `.nessie`
entry. A positively absent entry makes an unrelated service runtime directory
irrelevant, even when that directory is group-writable. Existing, unreadable
or symlinked Nessie state retains the owner, ancestor and permission checks.
Both elevated runtime admission and updater clearance use that same boundary;
managed records and independent kernel process inventories remain required.

Fedora 44 exposed the defect with `sssd` at `/run/sssd` and `gluster` at
`/run/gluster`: both runtime homes were 0775 and contained no Nessie state.
The worker exited before publishing drain/restart state, leaving the retained
1.0.13 transaction waiting after reboot. Do not chmod those service directories,
delete custody evidence or clear the transaction to make installation proceed.
The source regression covers absent state in 0775 homes, existing unsafe state,
owner mismatch and dangling state/home symlinks. Signed installed recovery
remains pending.
