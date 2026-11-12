# Instalacja Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Pliki do pobrania](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Użyj kodu z aplikacji, aby dodać komputer do właściwego zespołu w Nessie. Sprawdź uprawnienia, zanim agenci rozpoczną pracę.

## Linux

Pobierz odpowiedni pakiet dla Linuksa ze strony wydań, a następnie uruchom polecenie w folderze, w którym go zapisano.

Usługi działające w tle w Linuksie wymagają systemd. Pakiety zawierają środowisko uruchomieniowe; APT lub DNF instaluje Git i tmux jako zależności.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Po instalacji otwórz nowy terminal i sprawdź polecenie.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
