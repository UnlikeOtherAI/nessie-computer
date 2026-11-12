# A Nessie Computer telepítése

[macOS](Mac.md) · [Windows](Windows.md)

[Letöltések](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Az alkalmazásban látható kóddal adja hozzá a számítógépet a kívánt Nessie-csapathoz. Az ügynökök munkája előtt ellenőrizze a jogosultságokat.

## Linux

Töltse le a megfelelő Linux-csomagot a kiadások oldaláról, majd futtassa a parancsot abból a mappából, ahová mentette.

A Linux háttérszolgáltatásokhoz systemd szükséges. A csomagok tartalmazzák a futtatókörnyezetet; az APT vagy a DNF a Gitet és a tmuxot függőségként telepíti.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

A telepítés után nyisson új terminált, és ellenőrizze a parancsot.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
