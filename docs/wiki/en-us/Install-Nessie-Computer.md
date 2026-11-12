# Install Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Downloads](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Use the code shown in the app to add this computer to the intended team in Nessie. Review access before letting agents work.

## Linux

Download the matching Linux package from the releases page, then run the command from the folder where you saved it.

Linux background services require systemd. The packages include the runtime; APT or DNF installs Git and tmux as dependencies.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

After installation, open a new terminal and check the command.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
