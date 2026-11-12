# Install Nessie Computer

Install it on the computer the agents should use. Every computer needs its own
copy; installing it in one place doesn't give agents any other computer.

Downloads are on the [Releases page](https://github.com/UnlikeOtherAI/nessie-computer/releases).
Compare the download with its adjacent `.sha256` file or the release’s
`PACKAGE-SHA256SUMS`, when provided. Use the checksum from the same release.

If Nessie Computer is already installed, open it and check its version in
**Settings → Help** before downloading another copy. Nessie Desktop editions
differ; do not assume that the chat app includes this standalone app.

[Mac installation and verification](Mac.md) · [Windows installation and verification](Windows.md)

## Mac

Needs a Mac with Apple silicon (M1 or newer) and macOS 15 or later. Intel Macs
are not supported yet.

1. Download the `.dmg` file and open it.
2. Drag **Nessie Computer** to **Applications**.
3. Open it from Applications. Its icon appears in the menu bar, near the clock,
   and the window opens with a code to add your first team.
4. If macOS asks to allow Nessie Computer's background helper, choose
   **Open System Settings** and switch it on under **General → Login Items &
   Extensions**. The helper installs updates.

Can't see the icon? A crowded menu bar hides some icons, especially beside the
camera notch. Open Nessie Computer again from Applications or Spotlight; the
window opens.

The package is signed with UnlikeOtherAI's Developer ID (team `23B7GTLBN7`) and
notarised by Apple.

## Windows

Needs Windows 10 22H2 or later, x64.

1. Download the `.msi` file and open it.
2. Follow the installer. It adds **Nessie Computer** to the Start menu.
3. Open it from the Start menu. Its icon appears in the notification area by
   the clock, and the window opens with a code to add your first team.

New icons often start in the hidden part of the notification area (the **^**
arrow). To keep it visible, drag it out beside the clock, or turn it on in
**Settings → Personalisation → Taskbar → Other system tray icons**.

The installer is signed by **UnlikeOtherAI s.r.o.**

## Linux

Needs an x86-64 computer with systemd. There are packages for Debian and
Ubuntu (`.deb`) and Fedora (`.rpm`). On Linux you use the
[command line](Command-line.md); a small settings window for updates is included.

```sh
# Debian, Ubuntu
sudo apt install ./nessie-executor_<version>_amd64.deb

# Fedora
sudo dnf install ./nessie-executor_<version>_x86_64.rpm
```

Each package has a detached signature (`.asc`). The Linux publisher
fingerprint is `C2CDA17E5C87A0F3A22D0A511EEA727FD300D4B9`.

## Next

[Add a team](Add-a-team.md).

## Languages

[ar](ar/Install-Nessie-Computer.md) · [bg](bg/Install-Nessie-Computer.md) · [bs](bs/Install-Nessie-Computer.md) · [ca](ca/Install-Nessie-Computer.md) · [cs](cs/Install-Nessie-Computer.md) · [da](da/Install-Nessie-Computer.md) · [de](de/Install-Nessie-Computer.md) · [el](el/Install-Nessie-Computer.md) · [en-gb](en-gb/Install-Nessie-Computer.md) · [en-us](en-us/Install-Nessie-Computer.md) · [es](es/Install-Nessie-Computer.md) · [et](et/Install-Nessie-Computer.md) · [fi](fi/Install-Nessie-Computer.md) · [fr](fr/Install-Nessie-Computer.md) · [ga](ga/Install-Nessie-Computer.md) · [hi](hi/Install-Nessie-Computer.md) · [hr](hr/Install-Nessie-Computer.md) · [hu](hu/Install-Nessie-Computer.md) · [id](id/Install-Nessie-Computer.md) · [is](is/Install-Nessie-Computer.md) · [it](it/Install-Nessie-Computer.md) · [ja](ja/Install-Nessie-Computer.md) · [ko](ko/Install-Nessie-Computer.md) · [lt](lt/Install-Nessie-Computer.md) · [lv](lv/Install-Nessie-Computer.md) · [mk](mk/Install-Nessie-Computer.md) · [mt](mt/Install-Nessie-Computer.md) · [nl](nl/Install-Nessie-Computer.md) · [no](no/Install-Nessie-Computer.md) · [pl](pl/Install-Nessie-Computer.md) · [pt](pt/Install-Nessie-Computer.md) · [ro](ro/Install-Nessie-Computer.md) · [ru](ru/Install-Nessie-Computer.md) · [sk](sk/Install-Nessie-Computer.md) · [sl](sl/Install-Nessie-Computer.md) · [sq](sq/Install-Nessie-Computer.md) · [sr](sr/Install-Nessie-Computer.md) · [sv](sv/Install-Nessie-Computer.md) · [tr](tr/Install-Nessie-Computer.md) · [uk](uk/Install-Nessie-Computer.md) · [zh](zh/Install-Nessie-Computer.md)
