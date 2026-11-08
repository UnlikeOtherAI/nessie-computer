# Automatic executor updates

Status: **not released**. The Windows native installer coordinator and shared
local controls are implemented in source. No signed installed upgrade has been
verified, and macOS/Linux installer adapters and the transition release remain
unfinished. The published 0.9.1 prerelease and sequence-1 stable/preview
catalogs contain only the Apple-silicon DMG. They do not provide a complete
stable distribution or establish installed upgrade acceptance.

The Mac distribution reuses its existing Developer ID
Application identity and notarized DMG, with an approved app-bundled native
background helper. See [the helper trust contract](macos-update-helper.md).

Local signing candidates now exist for Windows and macOS. The Windows 0.9.0 MSI
at `c7ac37d` has verified timestamped signatures and matching extracted payload
hashes; its native helper and CLI report the expected version/source. The macOS
0.9.0 app and DMG at `b0e5c3b` passed Developer ID validation, notarization,
stapling and Gatekeeper. Neither candidate has been installed, published or
used for an A-to-B upgrade. No additional Installer certificate is required.
macOS signing uses a temporary launchd job in the existing GUI
session so SSH does not require another keychain sign-in or copied credentials.

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

## Windows installed setup and rollback

The signed a24bd9c 1.0.3 MSI passed publisher, profile-EKU, timestamp and SignTool
verification, but failed its first Maxis installation in SecureUpdaterStateRoot
(MSI 1722/1603). It is not a usable installed baseline and remains unpublished.
The default major-upgrade schedule had removed the old product outside the new
transaction. Maxis was recovered with the existing published signed edge MSI,
SHA-256 `8a7f7057fd97c13e89bd21b35feb6f15ef5e65aae048f8c67404ca10b1ddf005`.
Kelpie confirmed its existing pairing, shared folder and provider returned online.
No pairing or update journal was reset. Edge remains ineligible for stable A-to-B acceptance.

Protected directory pins now request READ_CONTROL as well as file attributes,
because [GetSecurityInfo](https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
requires that handle right to read owner/DACL information. The trusted-owner,
write-access, reparse and file-identity checks remain mandatory. Inherit-only
ACEs do not grant access to the directory itself; each executable input still
requires its own effective DACL check. The standard Program Files DACL and its
creator-owner inheritance are covered by a read-only Windows regression. A real Windows
fixture accepts an Administrators-owned directory with public read/execute and
rejects public write access; run the native Windows tests elevated as in CI.
The MSI uses [afterInstallInitialize](https://docs.firegiant.com/wix/schema/wxs/majorupgrade/)
so old-product removal participates in rollback. Corrected signed installation
and failed-upgrade rollback remain installed acceptance work.

The 2fcf592 signed 1.0.4 candidate passed 36 Windows native tests, source gates
and a forced MSI rollback: edge 0.0.2179 and its running service were restored
automatically. Normal installation still failed. A diagnostic transform ran
the exact signed native setup inside the deferred action, captured only public
runtime hashes/signatures and process identity, and always rolled back. Its
actual identity was SYSTEM in session 1; all runtime hashes and publishers matched.

MSI setup/removal and protected-image staging now require the real SYSTEM SID
without restricting the installing session. They still verify the fixed installed
release, publishers, hashes and protected namespace. Live updater worker/service
execution retains the separate SYSTEM-and-session-0 requirement. The correction
needs a fresh signed candidate and real installation before acceptance.

The ae2c3b6 1.0.5 setup diagnostic preserved its protected admission inode,
installation record and verified worker image, then failed service configuration.
Configuring an SC_ACTION_RESTART requires SERVICE_START on the service handle,
in addition to SERVICE_CHANGE_CONFIG ([Windows API contract](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-changeserviceconfig2a)).
Setup now requests both rights. Its elevated Windows regression creates one
uniquely named service pointing to a nonexistent executable, configures and reads
back its restart policy, and deletes the service without ever starting it.
Native setup retains its closed domain error code so a future refusal can be
diagnosed without paths, credentials or journal edits. Corrected signed setup
was exercised by signed candidate 1.0.6: the unmodified MSI completed, and both
executor and updater services ran with automatic startup. The installed desktop
status connection still refuses peer authentication, so local control health,
reconnection and A-to-B updates remain unverified. The protected state is retained.

For a refused Windows status request, the read-only developer probe is
`cargo run --manifest-path windows-common/Cargo.toml --example update-status`.
Compile it with the existing public `NESSIE_DESKTOP_WINDOWS_SIGNER_EKU` pin.
It uses the same authenticated fixed pipe and prints its closed failure reason;
it cannot change preferences, select packages or supply an alternate endpoint.
This is a machine-only diagnostic, not a replacement for the installed app/CLI
journey. Run it with the actual desktop token when diagnosing local controls.
The optional `--peer-facts` flag reports read-only Windows API failures, session,
SYSTEM identity and publisher/namespace results on a separate connection. It
exits unsuccessfully even when those probes pass; the independent facts never
substitute for authenticated status or grant authority.

Windows broker startup publishes read-only process and token metadata to
authenticated local users before opening its control pipe. Windows otherwise
refuses an ordinary desktop token even `PROCESS_QUERY_LIMITED_INFORMATION` on
the SYSTEM service (confirmed with signed 1.0.6). The broker merges only process
query/synchronize and token-query rights into the existing kernel DACLs. It
preserves existing permissions and grants no process control, memory access,
token duplication, impersonation or ACL writes. Client authentication still
requires the retained live process, SYSTEM/session 0, exact signed role and
protected installed image. A real suspended process and private duplicate token
regression assert the exact authenticated-user masks and retained SYSTEM access.
Startup verification failures report a nonzero SCM exit code, so the configured
recovery restart retries them instead of leaving a stopped service marked healthy.
The read-only status probe also reports the failed transport stage, Windows error
or closed broker error using the production exchange. Application calls keep
their existing public error; no diagnostic flag bypasses authentication or changes
timeouts. Signed 1.0.7 passed normal installation and desktop peer verification;
its subsequent control exchange is still under investigation and is not accepted.
Windows nonblocking pipe acceptance distinguishes listening from a connected
client: a successful first ConnectNamedPipe call only makes the instance
available; ERROR_PIPE_CONNECTED establishes the connection. The kernel pipe
regression covers an empty listener, a real client and abandoned-client recovery.
The `--installed-facts` probe prints read-only known-folder and installed-runtime
verification stage timings. It has no install or policy operation and does not
turn a successful provenance read into a broker-health assertion. Signed 1.0.8
installed normally, but its desktop control still timed out and its background
worker had not created a journal; it remains unpublished and unaccepted.
