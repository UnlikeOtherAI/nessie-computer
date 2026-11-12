# Nessie Computer for Mac

Requires Apple silicon (M1 or newer) and macOS 15 or later. Intel Macs are not supported.

1. Download `Nessie-Computer-macOS-Apple-Silicon.dmg` from [GitHub Releases](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-macOS-Apple-Silicon.dmg).
2. Open the disk image and drag **Nessie Computer** to **Applications**. The bundle's filename remains `Nessie Executor.app` for upgrades; Finder displays Nessie Computer.
3. Open the app from Applications. Its window and menu bar icon appear. If the icon is hidden by the camera notch, opening the app again shows its window.
4. When prompted, approve the background helper in **System Settings → General → Login Items & Extensions**. The helper manages the protected runtime and updates.
5. Follow [Add a team](Add-a-team.md): use the displayed code, open Nessie, check the selected team and connect. Review the team's access permissions.

The release must be signed by **UnlikeOtherAI s.r.o.**, Apple team `23B7GTLBN7`, and notarised. Do not bypass Gatekeeper if the download is rejected; report the release and error instead.

After helper approval, open a new Terminal and run `nessie-computer --version` and `nessie-computer --help`. The helper installs `/usr/local/bin/nessie-computer` and retains the old `nessie-executor` command. It preserves unrelated launchers and a package-manager-owned directory; if the command is missing, check the helper status and the CLI location in **Settings → Help**. Do not replace files or change ownership to force installation.

To check the download, compare `shasum -a 256 Nessie-Computer-macOS-Apple-Silicon.dmg` with the checksum published beside that exact asset. `xcrun stapler validate Nessie-Computer-macOS-Apple-Silicon.dmg` checks its attached notarisation ticket.

For upgrades, let active work finish and quit Nessie Computer before replacing the app.
Also quit older Nessie Desktop copies while the protected runtime upgrades; they
can keep it waiting. The helper retries automatically. Check **Settings → Software
updates → Installed version** and `nessie-computer --version` before reopening
Desktop: the app bundle alone does not prove the runtime has upgraded. Keep its existing application-support data. Removing the app does not revoke team connections: [Disconnect or uninstall](Disconnect-or-uninstall.md).

[Installation](Install-Nessie-Computer.md) · [Settings and updates](Settings-and-updates.md)
