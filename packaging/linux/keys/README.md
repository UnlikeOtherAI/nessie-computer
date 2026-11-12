# Linux package publisher

Nessie Computer packages use the UnlikeOtherAI s.r.o. release key:

`18C55D26575E8B13AB9C4D98818563E10A787D82`

The native updater embeds `unlikeotherai-executor.gpg` and verifies a detached
`<package>.asc` signature with `gpgv` before inspecting or installing a DEB/RPM.
The signed catalogue must contain both assets and their exact hashes and sizes.
No user keyring or downloaded key can replace this publisher.

Only public key material belongs here. The previous key
`C2CDA17E5C87A0F3A22D0A511EEA727FD300D4B9` was replaced on 12 November 2026
with the owner's approval before general distribution: its sole saved
passphrase could no longer be decrypted by Windows DPAPI. Linux packages must
be rebuilt with this public key before publication. The macOS and Windows
publishers are separate identities and are unchanged.

The release key is passphrase-free for unattended signing. Its private export
is protected by owner-only file access on each development computer and by the
main-only `executor-cli-release` GitHub environment, not by a machine-specific
password encryption store. Never commit it or include it in build artifacts.
The key does not expire automatically; rotate it deliberately if required.

Local configuration sets these environment variables:

- `NESSIE_LINUX_SIGNING_HOME`: the dedicated GnuPG keyring.
- `NESSIE_RPM_SIGNING_KEY_FILE`: the protected ASCII-armored private export.
- `NESSIE_REPOSITORY_SIGNING_FINGERPRINT`: the full fingerprint above.

Source the protected directory's `environment.sh` on Unix. Windows stores the
same paths in the user's persistent environment; open a new PowerShell to use
them. No execution-policy change or profile script is required.
To build a signed repository, set `GNUPGHOME` to `NESSIE_LINUX_SIGNING_HOME` for
that command; do not replace the person's normal GnuPG home globally.

Before a release or after restoring a machine, run
`node packaging/linux/verify-signing.mjs`. It restores the private export into
a temporary keyring, signs a fresh challenge without prompting and verifies it
against the public key embedded in this repository. Its temporary signing agent
and keyring are removed when the check finishes, including over Windows SSH.
The production GitHub workflow runs the same check before compilation. Keep at
least two independently usable machine copies; verify a restored copy before
retiring a machine or removing an older backup. Restore by importing the
protected private export into a new owner-only GnuPG home, then rerun the check.
