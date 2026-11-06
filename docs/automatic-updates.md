# Automatic executor updates

Status: **not released**. Source extraction and signed catalogue verification
exist. Installed computers do not yet update themselves. The native installer,
local controls, notifications and transition release remain to be implemented
and exercised on each supported operating system.

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
it maps only package shapes the native installer accepts (currently the Apple
Silicon DMG) and refuses any other file. The manual `Publish Update Catalogue`
workflow runs both commands in the `executor-updates` environment on main and
replaces `catalog.json` on the channel's `update-catalog-<channel>` release. Candidate attestations,
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

Use the actual signed installed package on Windows, macOS and Linux. Exercise
automatic installation, persistent opt-out, popup and reminders, explicit
update, active work, offline recovery, interrupted installation and reboot.
Check pairings, folder permissions, local provider custody, service identities
and the persistent admission inode before and after. Reject modified metadata,
wrong publishers, wrong architecture and incompatible protocols through the
same real interface. Browser journeys and matching screenshot evidence apply
when the console changes. No installed flow is claimed by the current unit
tests or native compilation.
