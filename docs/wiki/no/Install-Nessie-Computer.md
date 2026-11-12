# Installer Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Nedlastinger](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Bruk koden fra appen til å legge datamaskinen til ønsket team i Nessie. Gå gjennom tilgangstillatelsene før agentene arbeider.

## Linux

Last ned riktig Linux-pakke fra utgivelsessiden og kjør kommandoen fra mappen der du lagret den.

Bakgrunnstjenester på Linux krever systemd. Pakkene inneholder kjøretiden; APT eller DNF installerer Git og tmux som avhengigheter.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Åpne en ny terminal etter installasjonen og kontroller kommandoen.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
