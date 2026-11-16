# Setja upp Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Niðurhal](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Notaðu kóðann úr forritinu til að bæta tölvunni við rétt teymi í Nessie. Farðu yfir aðgangsheimildir áður en fulltrúarnir vinna.

Ef sama teymi er bætt við aftur haldast núverandi tenging þess og heimildir. Afturköllun lýkur sjálfkrafa þegar tengingin kemst aftur á. Í Windows greinast Claude Code og Codex sem sett eru upp með npm sjálfkrafa.

## Linux

Sæktu viðeigandi Linux-pakka af útgáfusíðunni og keyrðu skipunina í möppunni þar sem þú vistaðir hann.

Bakgrunnsþjónustur á Linux krefjast systemd. Pakkarnir innihalda keyrsluumhverfið; APT eða DNF setur upp Git og tmux sem undirpakka.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Opnaðu nýjan skjáhermi eftir uppsetningu og prófaðu skipunina.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
