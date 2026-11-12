# Instal·lar Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Baixades](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Feu servir el codi de l’aplicació per afegir l’ordinador a l’equip desitjat a Nessie. Reviseu els permisos abans que treballin els agents.

## Linux

Baixeu el paquet de Linux adequat de la pàgina de versions i executeu l'ordre des de la carpeta on l'heu desat.

Els serveis de segon pla de Linux requereixen systemd. Els paquets inclouen el temps d'execució; APT o DNF instal·len Git i tmux com a dependències.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Després de la instal·lació, obriu un terminal nou i comproveu l'ordre.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
