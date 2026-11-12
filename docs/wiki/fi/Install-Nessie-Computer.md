# Asenna Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Lataukset](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Lisää tietokone haluamaasi Nessie-tiimiin sovelluksen näyttämällä koodilla. Tarkista käyttöoikeudet ennen agenttien työskentelyä.

## Linux

Lataa sopiva Linux-paketti julkaisusivulta ja suorita komento kansiossa, johon tallensit sen.

Linuxin taustapalvelut vaativat systemd:n. Paketit sisältävät ajonaikaisen ympäristön; APT tai DNF asentaa Gitin ja tmuxin riippuvuuksina.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Avaa asennuksen jälkeen uusi pääte ja tarkista komento.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
