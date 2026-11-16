# Instaloni Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Shkarkime](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Përdorni kodin nga aplikacioni për ta shtuar kompjuterin në ekipin e dëshiruar në Nessie. Kontrolloni lejet para se agjentët të punojnë.

Shtimi sërish i të njëjtit ekip ruan lidhjen dhe lejet ekzistuese. Anulimi përfundon automatikisht kur lidhja rikthehet. Në Windows, Claude Code dhe Codex të instaluar përmes npm zbulohen automatikisht.

## Linux

Shkarkoni paketën e duhur për Linux nga faqja e versioneve dhe ekzekutoni komandën nga dosja ku e ruajtët.

Shërbimet e sfondit në Linux kërkojnë systemd. Paketat përfshijnë ekzekutimin; APT ose DNF instalon Git dhe tmux si varësi.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Pas instalimit, hapni një terminal të ri dhe kontrolloni komandën.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
