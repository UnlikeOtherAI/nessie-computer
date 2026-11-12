# Installer Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Téléchargements](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Utilisez le code affiché dans l’application pour ajouter cet ordinateur à l’équipe souhaitée dans Nessie. Vérifiez les autorisations avant de laisser travailler les agents.

## Linux

Téléchargez le paquet Linux adapté depuis la page des versions, puis exécutez la commande dans le dossier où vous l’avez enregistré.

Les services d’arrière-plan Linux exigent systemd. Les paquets incluent l’environnement d’exécution ; APT ou DNF installent Git et tmux comme dépendances.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Après l’installation, ouvrez un nouveau terminal et vérifiez la commande.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
