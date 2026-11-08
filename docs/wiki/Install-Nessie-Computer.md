# Install Nessie Computer

Install it on the computer the agents should use. Every computer needs its own
copy; installing it in one place doesn't give agents any other computer.

Downloads are on the [Releases page](https://github.com/UnlikeOtherAI/nessie-executor/releases).
Each release lists its files with checksums in `PACKAGE-SHA256SUMS`.

If you use **Nessie Desktop** on a Mac or PC, Nessie Computer is already
included. Skip to [Add this computer](Add-this-computer).

## Mac

Needs a Mac with Apple silicon (M1 or newer) and macOS 15 or later. Intel Macs
are not supported yet.

1. Download the `.dmg` file and open it.
2. Drag **Nessie Computer** to **Applications**.
3. Open it from Applications. Its icon appears in the menu bar, near the clock,
   and the window opens on **Overview**.
4. If macOS asks to allow Nessie Computer's background helper, choose
   **Open System Settings** and switch it on under **General → Login Items &
   Extensions**. The helper installs updates.

Can't see the icon? A crowded menu bar hides some icons, especially beside the
camera notch. Open Nessie Computer again from Applications or Spotlight; the
window opens.

The package is signed with UnlikeOtherAI's Developer ID (team `23B7GTLBN7`) and
notarised by Apple.

## Windows

Needs Windows 10 or 11, 64-bit.

1. Download the `.msi` file and open it.
2. Follow the installer. It adds **Nessie Computer** to the Start menu.
3. Open it from the Start menu. Its icon appears in the notification area by
   the clock, and the window opens on **Overview**.

New icons often start in the hidden part of the notification area (the **^**
arrow). To keep it visible, drag it out beside the clock, or turn it on in
**Settings → Personalisation → Taskbar → Other system tray icons**.

The installer is signed by **UnlikeOtherAI s.r.o.**

## Linux

Needs an x86-64 computer with systemd. There are packages for Debian and
Ubuntu (`.deb`) and Fedora (`.rpm`). On Linux you use the
[command line](Command-line); a small settings window for updates is included.

```sh
# Debian, Ubuntu
sudo apt install ./nessie-executor_<version>_amd64.deb

# Fedora
sudo dnf install ./nessie-executor_<version>_x86_64.rpm
```

Each package has a detached signature (`.asc`). The Linux publisher
fingerprint is `C2CDA17E5C87A0F3A22D0A511EEA727FD300D4B9`.

## Next

[Add this computer](Add-this-computer).
