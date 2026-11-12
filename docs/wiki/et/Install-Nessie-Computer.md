# Nessie Computeri paigaldamine

[macOS](Mac.md) · [Windows](Windows.md)

[Allalaadimised](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Lisage arvuti rakenduses kuvatud koodi abil soovitud Nessie meeskonda. Kontrollige õigusi enne agentide töö alustamist.

## Linux

Laadi väljalasete lehelt alla sobiv Linuxi pakett ja käivita käsk kaustas, kuhu selle salvestasid.

Linuxi taustateenused vajavad systemd-d. Paketid sisaldavad käitusaega; APT või DNF paigaldab sõltuvustena Gitti ja tmuxi.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Pärast paigaldamist ava uus terminal ja kontrolli käsku.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
