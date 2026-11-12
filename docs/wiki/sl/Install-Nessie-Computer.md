# Namestitev Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Prenosi](https://github.com/UnlikeOtherAI/nessie-computer/releases)

S kodo iz aplikacije dodajte računalnik želeni ekipi v Nessie. Preden agenti začnejo delati, preverite dovoljenja.

## Linux

Prenesite ustrezen paket za Linux s strani izdaj in zaženite ukaz iz mape, v katero ste ga shranili.

Linux storitve v ozadju zahtevajo systemd. Paketi vsebujejo izvajalno okolje; APT ali DNF namestita Git in tmux kot odvisnosti.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Po namestitvi odprite nov terminal in preverite ukaz.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
