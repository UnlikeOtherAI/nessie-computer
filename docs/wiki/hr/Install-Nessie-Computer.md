# Instalacija Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Preuzimanja](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Kod iz aplikacije upotrijebite za dodavanje računala željenom timu u Nessie. Provjerite dopuštenja prije nego što agenti počnu raditi.

## Linux

Preuzmite odgovarajući paket za Linux sa stranice izdanja i pokrenite naredbu iz mape u koju ste ga spremili.

Linux pozadinske usluge zahtijevaju systemd. Paketi uključuju izvršno okruženje; APT ili DNF instaliraju Git i tmux kao ovisnosti.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Nakon instalacije otvorite novi terminal i provjerite naredbu.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
