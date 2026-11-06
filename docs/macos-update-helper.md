# macOS updates with the existing Developer ID identity

Status: implementation in progress. No installed upgrade is claimed.

The distribution identity is the existing `Developer ID Application:
UnlikeOtherAI s.r.o. (23B7GTLBN7)`. Its certificate is on the Mac Desktop and its
private key is already in the login keychain. The signed 0.9.0 app and DMG have
already passed notarization and Gatekeeper with this identity. No new Apple
account, publisher or certificate is needed for that distribution format.

The updater uses the notarized DMG and an app-bundled native LaunchDaemon
registered through `SMAppService`. It needs no Developer ID Installer identity.
Apple documents the [bundle-relative helper layout and approval
model](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos).
An administrator must approve the background helper once in System Settings;
its status and the route to approval belong in the local Settings page.

## Trust and installation

The helper is the existing native executable, signed inside the app. Its plist
lives in `Contents/Library/LaunchDaemons` and uses a fixed `BundleProgram` and
fixed command. It accepts no caller-selected path, URL, executable or command.
Registration never grants Node or a web page Root execution.

On its first approved launch the helper validates its own loaded publisher,
the enclosing app's sealed compatibility floor, and the bundled runtime's
hashes, numeric version and compiled source revision. It copies that runtime
into a Root-owned staging directory, verifies the readonly copied contents,
then atomically selects the immutable release. It preserves the existing
custody inode and journals. Initial migration still waits for legacy creators
and work to finish naturally; it never signals a process to obtain clearance.
The copied app is read by an unprivileged process inside a private directory,
then frozen and verified. A verified snapshot is reused for retries rather than
copying the same app on each restart.

The registered job then executes the protected native broker image. Existing
accepted workers, durable retry state and the socket contract remain unchanged.
A later app launch must resume the protected installed factory; it must not
replace that factory from an older bundled runtime or reset removal intent.

## Replacement

The signed catalogue names an immutable DMG asset with its size and SHA-256.
The native adapter verifies the DMG's publisher and Gatekeeper result before
mounting it readonly at a protected location. It stages and validates the app
and its bundled runtime against the accepted version/source, then uses the
existing machine barrier, drain and independent clearance proof for replacement.
No shell or arbitrary installer script runs as Root.

The app and CLI factory switch in one journaled transaction. A macOS atomic
directory exchange preserves the app's registered helper throughout replacement;
the old app and runtime remain available for recovery. Partial replacement
keeps admissions fenced and retries the accepted bytes. Completion requires the
new runtime generation and the appropriate application restart proof. A nested
menu app inside Nessie Desktop remains part of that signed parent bundle; it
must reopen as an independent consumer of the new installed runtime without
requiring its unchanged bundle to carry the runtime's new source revision.

All existing publisher, manifest, Root ownership, process-generation and
credential-custody checks remain mandatory. Homebrew-owned installations retain
their package-manager ownership. First setup, denial/recovery, active work,
opt-out, reboot and signed A-to-B replacement still require installed testing
on the Mac before publication.

The public release also supplies the actual Mac and Windows URLs used by
Nessie's Computers page. Its existing download buttons must not be enabled
before those public immutable assets exist and their anonymous downloads verify.

At `e511bf8`, 42 Mac helper tests and 17 updater tests passed. App/Core typechecking
and strict Swift lint passed at `3bbadc4`; 31 focused update tests and the public
TypeScript gate passed on Maxis. The setup, denial and retry controls passed
18 headless shared-console journeys. These source checks do not establish an
approved installed helper or a completed signed upgrade.

The `e511bf8` 0.9.0 DMG was signed, notarized, stapled and accepted by Gatekeeper
on the Mac. SHA-256:
`efb1d4c683bd8338f5c064101d90271673e5786c536d293f7206a50f347c0e71`.
The same verified app was installed in `/Applications`, with the previous app
retained outside the checkout. Its compiled `build-info` reports version 0.9.0
and source `e511bf86d9f0c3ffccbd7fd67e9ade1ee0579e4e`. The real local Settings
rendered setup and its button opened macOS background-helper approval. This
does not yet establish an approved Root helper or an A-to-B upgrade.

The registration fix at `c79eac7` passed Core tests, strict Swift lint and the
full App/Core typecheck. Its new signed and notarized 0.9.0 app is installed;
macOS's administrator approval is recorded and its Root job starts. The first
protected copy exposed a `ditto` destination-resolution failure. A private-cwd
archive-copy probe preserved the signed app and passed Gatekeeper; the native
replacement still requires a signed installed retry. No protected factory or
completed upgrade is claimed yet. Existing failed snapshots and journals remain.

The same revision's 0.9.0 Windows MSI was built and signed on Maxis. It passed
publisher, profile EKU, timestamp, SignTool and updater-protocol inspection;
SHA-256 `fbe63a66d41b90866d0e0dff9d11091e8dadaff6cb2dcc8570e5cee6e71f10d4`.
It remains uninstalled and unpublished. Matching setup screenshots cover the
actual base `54c6175`, two console widths and all seven supported locales, with
denial/retry journeys. Their broker responses are fixtures, not installed proof.

The signed `879a601` app was subsequently installed by atomic exchange, using
the existing approval. Its Root service stays running after snapshot creation
and validation, with public maintenance state draining and no selected factory.
It is waiting for older Nessie/CTO processes. Those processes and their journals
remain intact pending coordinated shutdown; this is not a completed migration.
The DMG SHA-256 is
`0c1632af196b026d882164d49d612b125d9cf0d64c678495684c4def3dd39bac`.

With explicit permission, the legacy CTO service was stopped through launchd
and Nessie Desktop through its Quit action. The CTO job's automatic relaunch is
disabled; its configuration and state are retained. The helper then selected
release `906495a8666c565113599a225c82bc4423ff92067c83cbb8264cf37b85db6a93`.
Its compiled build information reports 0.9.0 at `879a601`, the protected broker
and worker run, and maintenance has returned to non-draining. Status RPCs still
time out, including a 25-second authenticated-peer diagnostic. Preserve this
live failure while debugging; do not restart the service or clear its journals
to hide it. No completed update or working Settings control is claimed.

Read-only live sampling isolated the delay to repeated payload hashing and
signature validation on the broker's listener and ordinary status path. Three
subsequent status requests returned the correct protected version and policy
after 5.0–6.3 seconds, beyond the native client's five-second deadline. Worker
supervision now runs separately from socket acceptance. Status retains one
fully verified release for version and eligibility together; irrelevant health
and application-restart observations are rejected before payload verification.
No verification result is cached across requests or used to authorize creation.
Installed timing and recovery still need verification with the signed fix.

Managed CLI creation now binds its release to the kernel's loaded native image,
not the mutable `current` launch alias. The Mac regression test launches the
test executable through a symlink and confirms the same kernel image is used.
