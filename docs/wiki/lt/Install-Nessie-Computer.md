# Įdiegti Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Atsisiuntimai](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Programoje rodomu kodu pridėkite kompiuterį prie norimos Nessie komandos. Prieš agentams pradedant darbą patikrinkite prieigos leidimus.

## Linux

Iš leidimų puslapio atsisiųskite tinkamą „Linux“ paketą ir paleiskite komandą aplanke, kuriame jį išsaugojote.

Linux fono paslaugoms reikia systemd. Paketuose yra vykdymo aplinka; APT ar DNF įdiegia Git ir tmux kaip priklausomybes.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Įdiegę atidarykite naują terminalą ir patikrinkite komandą.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
