# Nessie Computer installeren

[macOS](Mac.md) · [Windows](Windows.md)

[Downloads](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Voeg de computer met de code uit de app toe aan het gewenste team in Nessie. Controleer de toegangsrechten voordat agenten aan het werk gaan.

## Linux

Download het passende Linux-pakket van de releasepagina en voer het commando uit in de map waarin je het hebt opgeslagen.

Linux-achtergrondservices vereisen systemd. De pakketten bevatten de runtime; APT of DNF installeert Git en tmux als afhankelijkheden.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Open na de installatie een nieuwe terminal en controleer het commando.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
