# Windows 1.1.0 release verification

Verified on 12 November 2026. Binary source:
`0eedf3601fc3e24f2ac12518394f5e4994c031c4`.

The x64 MSI was built on Maxis, with active source, tools and output on C:.
Signing used Minis and the existing UnlikeOtherAI Azure Artifact Signing
`NessiePublicTrust` profile. The five product executable payloads and final MSI
passed publisher, profile EKU, timestamp and `signtool verify /pa /all /tw`
checks. Transferred signed bytes were verified again on Maxis.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `NessieExecutor_1.1.0_x64.msi` | 58,208,256 | `133a3c6902b2643bc947c70c1c3d40e85742da3c184cd750f7122d8e91742f3a` |
| `Nessie-Computer-Windows-x64.msi` | 58,208,256 | `133a3c6902b2643bc947c70c1c3d40e85742da3c184cd750f7122d8e91742f3a` |

Both assets were downloaded from the draft GitHub release. Their bytes matched,
and each checksum named the corresponding asset. The downloaded stable alias
passed Authenticode and SignTool verification on Maxis before installation.

The MSI upgraded the existing 1.0.21 installation to 1.1.0 with exit code 0 and
no reboot. The installed manifest matched the source above. The service was
running as `NT SERVICE\NessieExecutor`.

With the updated PATH, `nessie-computer` resolved to
`C:\Program Files\Nessie Executor\nessie-computer.cmd`. `--version` returned
`nessie-computer 1.1.0`; `--version`, `--help` and `status --json` exited 0, and
the status output parsed as JSON.

The installed Start menu shortcut opened the Nessie Computer window in the
existing desktop session. The registered
`nessie-computer://open?section=settings` link opened Settings, where Windows
UI Automation read installed version 1.1.0. No team permissions were changed.

These checks cover a manual signed upgrade and the installed entry points.
They do not establish automatic catalogue updates, a new team connection or a
sandbox boot. The release remained a draft during verification; anonymous
public downloads and the `latest` links must be checked after publication.
