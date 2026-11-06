# macOS updates with the existing Developer ID identity

Status: implementation in progress. No installed upgrade is claimed.

The distribution identity is the existing `Developer ID Application:
UnlikeOtherAI s.r.o. (23B7GTLBN7)`. Its certificate is on the Mac Desktop and its
private key is already in the login keychain. The signed 0.9.0 app and DMG have
already passed notarization and Gatekeeper with this identity. No new Apple
account, publisher or certificate is needed for that distribution format.

The earlier updater prototype selected a PKG, which introduced a separate
Developer ID Installer requirement. Replace that route with the notarized DMG
and an app-bundled native LaunchDaemon registered through `SMAppService`.
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

The app and CLI factory switch in one journaled transaction. Partial replacement
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
