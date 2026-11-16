# Installera Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Hämtningar](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Använd koden från appen för att lägga till datorn i önskat team i Nessie. Granska åtkomstbehörigheterna innan agenterna arbetar.

Om du lägger till samma team igen behålls dess befintliga anslutning och behörigheter. Avbrottet slutförs automatiskt när anslutningen återställs. På Windows upptäcks Claude Code och Codex som installerats via npm automatiskt.

## Linux

Hämta rätt Linux-paket från utgåvesidan och kör kommandot från mappen där du sparade det.

Linux-bakgrundstjänster kräver systemd. Paketen innehåller körmiljön; APT eller DNF installerar Git och tmux som beroenden.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Öppna en ny terminal efter installationen och kontrollera kommandot.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
