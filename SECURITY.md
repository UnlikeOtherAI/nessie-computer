# Security reports and trust boundaries

Report a suspected vulnerability through GitHub's private vulnerability
reporting for this repository. Do not post credentials, local files, pairing
keys or exploit details in a public issue.

The executor is local software with access explicitly granted by the
computer's owner. A server-side team grant does not replace local permissions.
The public protocol package defines the wire contract; it grants no authority
by itself. UOA remains the authority for human identity and team membership.

Native custody checks bind processes to an immutable installed release and
verify their creation and lifetime. A version string, a new file beside an old
process, a process group or a successful compiler run does not establish
credential custody. Never weaken these checks to make development builds
eligible for personal credentials.

Official Windows packages use UnlikeOtherAI's existing Azure Artifact Signing
publisher. Official macOS packages use Developer ID signing and notarization.
Linux packages and repository metadata are signed. Ordinary public pull request
builds have no production signing credentials or privileged release permissions.

Update installation must authenticate the release, preserve local state and
credential fences, and use the supported native clearance and restart path.
Remote pages and teams cannot select an executable, update origin or install
arbitrary commands through the local control bridge.
