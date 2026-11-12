# Instalarea Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Descărcări](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Folosiți codul din aplicație pentru a adăuga computerul la echipa dorită în Nessie. Verificați permisiunile înainte ca agenții să lucreze.

## Linux

Descărcați pachetul Linux potrivit de pe pagina de versiuni și executați comanda din dosarul în care l-ați salvat.

Serviciile de fundal Linux necesită systemd. Pachetele includ runtime-ul; APT sau DNF instalează Git și tmux ca dependențe.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

După instalare, deschideți un terminal nou și verificați comanda.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
