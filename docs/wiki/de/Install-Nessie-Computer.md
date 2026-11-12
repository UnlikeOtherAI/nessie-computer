# Nessie Computer installieren

[macOS](Mac.md) · [Windows](Windows.md)

[Downloads](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Fügen Sie den Computer mit dem Code aus der App dem gewünschten Team in Nessie hinzu. Prüfen Sie die Zugriffsrechte, bevor Agenten arbeiten.

## Linux

Laden Sie das passende Linux-Paket von der Release-Seite herunter und führen Sie den Befehl in dem Ordner aus, in dem Sie es gespeichert haben.

Linux-Hintergrunddienste benötigen systemd. Die Pakete enthalten die Laufzeitumgebung; APT oder DNF installiert Git und tmux als Abhängigkeiten.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Öffnen Sie nach der Installation ein neues Terminal und prüfen Sie den Befehl.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
