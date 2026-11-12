# Native release downloads

Build Windows on Maxis and macOS on dictator from the same committed source and
numeric version. Use the existing UnlikeOtherAI signing identities. Preserve the
versioned filenames emitted by `packaging/windows/build-msi.mjs` and
`packaging/macos/build-dmg.mjs`; update catalogues refer to these immutable assets.

For human downloads, attach identical copies under these names to the same draft
GitHub Release:

| Versioned asset | Stable download name |
| --- | --- |
| `NessieExecutor_<version>_arm64.dmg` | `Nessie-Computer-macOS-Apple-Silicon.dmg` |
| `NessieExecutor_<version>_x64.msi` | `Nessie-Computer-Windows-x64.msi` |
| `nessie-executor_<version>_amd64.deb` | `Nessie-Computer-Linux-x64.deb` |
| `nessie-executor_<version>_x86_64.rpm` | `Nessie-Computer-Linux-x64.rpm` |

Linux aliases also carry identical copies of their versioned detached `.asc` signatures.
Build Linux packages on a Linux x86-64 host and verify them with the existing publisher key.

Each alias also needs its own `.sha256` file: retain the same digest but name the
alias inside the checksum file. Verify byte equality before upload and download
both assets again to verify their hashes. Never replace an asset in a published
release or substitute an unsigned candidate.

The permanent human links are
`https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/<stable-download-name>`.
They resolve only after a non-prerelease release is published and marked latest.
Keep the release in draft until source checks, publisher and timestamp checks,
Apple notarisation, downloaded-byte verification, actual installation, app launch
and the installed `nessie-computer --version` and `--help` entry points pass on
each supported OS. Record source SHA, size, SHA-256 and concrete verification
limits. The parent release coordinator publishes after that review.

The Mac app's bundle path and Windows installation directory retain their
existing identities. Do not rename them when changing a download's filename.
