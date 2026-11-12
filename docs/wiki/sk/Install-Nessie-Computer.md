# Inštalácia Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Na stiahnutie](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Pomocou kódu z aplikácie pridajte počítač do požadovaného tímu v Nessie. Pred prácou agentov skontrolujte oprávnenia.

## Linux

Stiahnite zodpovedajúci balíček pre Linux zo stránky vydaní a spustite príkaz z priečinka, do ktorého ste ho uložili.

Služby na pozadí v Linuxe vyžadujú systemd. Balíčky obsahujú runtime; APT alebo DNF nainštaluje Git a tmux ako závislosti.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Po inštalácii otvorte nový terminál a overte príkaz.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
