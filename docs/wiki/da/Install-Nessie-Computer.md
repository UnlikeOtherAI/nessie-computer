# Installer Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Downloads](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Brug koden fra appen til at føje computeren til det ønskede team i Nessie. Gennemgå adgangstilladelserne, før agenterne arbejder.

## Linux

Hent den relevante Linux-pakke fra udgivelsessiden, og kør kommandoen fra den mappe, hvor du gemte den.

Linux-baggrundstjenester kræver systemd. Pakkerne indeholder runtimen; APT eller DNF installerer Git og tmux som afhængigheder.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Åbn en ny terminal efter installationen, og kontrollér kommandoen.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
