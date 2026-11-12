# Installare Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Download](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Usa il codice mostrato nell’app per aggiungere il computer al team desiderato in Nessie. Controlla i permessi prima che gli agenti lavorino.

## Linux

Scarica il pacchetto Linux adatto dalla pagina delle versioni, poi esegui il comando dalla cartella in cui l’hai salvato.

I servizi in background su Linux richiedono systemd. I pacchetti includono il runtime; APT o DNF installano Git e tmux come dipendenze.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Dopo l’installazione, apri un nuovo terminale e verifica il comando.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
