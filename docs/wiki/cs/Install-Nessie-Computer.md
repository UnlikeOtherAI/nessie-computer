# Instalace Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Ke stažení](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Pomocí kódu z aplikace přidejte počítač do požadovaného týmu v Nessie. Než agenti začnou pracovat, zkontrolujte oprávnění.

## Linux

Stáhněte odpovídající balíček pro Linux ze stránky vydání a spusťte příkaz ze složky, kam jste jej uložili.

Linuxové služby na pozadí vyžadují systemd. Balíčky obsahují běhové prostředí; APT nebo DNF nainstalují Git a tmux jako závislosti.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Po instalaci otevřete nový terminál a ověřte příkaz.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
