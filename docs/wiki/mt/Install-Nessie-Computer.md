# Installa Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Tniżżil](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Uża l-kodiċi fl-app biex iżżid il-kompjuter mat-tim mixtieq f’Nessie. Iċċekkja l-permessi qabel ma l-aġenti jibdew jaħdmu.

## Linux

Niżżel il-pakkett Linux xieraq mill-paġna tar-rilaxxi, imbagħad ħaddem il-kmand mill-fowlder fejn issejvjajtu.

Is-servizzi tal-isfond ta’ Linux jeħtieġu systemd. Il-pakketti jinkludu r-runtime; APT jew DNF jinstallaw Git u tmux bħala dipendenzi.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Wara l-installazzjoni, iftaħ terminal ġdid u ċċekkja l-kmand.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
