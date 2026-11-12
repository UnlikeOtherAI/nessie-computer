# Инсталација Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Преузимања](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Кодом из апликације додајте рачунар жељеном тиму у Nessie. Проверите дозволе пре него што агенти почну да раде.

## Linux

Preuzmite odgovarajući Linux paket sa stranice izdanja i pokrenite komandu iz fascikle u koju ste ga sačuvali.

Linux pozadinske usluge zahtevaju systemd. Paketi uključuju runtime; APT ili DNF instalira Git i tmux kao zavisnosti.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Posle instalacije otvorite novi terminal i proverite komandu.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
