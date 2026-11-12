# Nessie Computer for Windows

Requires Windows 10 22H2 or later on x64. The installer needs administrator approval. Node and the local runtime are included; a development toolchain is not required.

1. Download `Nessie-Computer-Windows-x64.msi` from [GitHub Releases](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi).
2. Open the MSI and follow the installer. Verify the publisher is **UnlikeOtherAI s.r.o.** before approving installation.
3. Open **Nessie Computer** from Start. Its icon may be under the notification area's hidden icons (**^**); choose it to open the window.
4. Follow [Add a team](Add-a-team.md): use the displayed code, open Nessie, check the selected team and connect. Review the team's access permissions.

Open a new PowerShell window after installation and run:

```powershell
nessie-computer --version
nessie-computer --help
```

The installer adds its directory to PATH. The installed folder remains `C:\Program Files\Nessie Executor`; the old `nessie-executor` command remains available for existing scripts. Do not rename the installation folder or copy the machine's state to another computer.

To check the downloaded MSI before installation:

```powershell
Get-AuthenticodeSignature .\Nessie-Computer-Windows-x64.msi | Format-List Status,SignerCertificate,TimeStamperCertificate
Get-FileHash .\Nessie-Computer-Windows-x64.msi -Algorithm SHA256
```

The signature must be `Valid`, with the publisher above and a timestamp. Compare the hash with the checksum published beside that exact asset. If verification fails, download again from the release page and report a continuing failure; do not disable Windows security checks.

For upgrades, let active work finish and close the app before running the newer MSI. The installer preserves team state. Disconnect teams before uninstalling if you want to revoke their access: [Disconnect or uninstall](Disconnect-or-uninstall.md).

[Installation](Install-Nessie-Computer.md) · [Settings and updates](Settings-and-updates.md)
