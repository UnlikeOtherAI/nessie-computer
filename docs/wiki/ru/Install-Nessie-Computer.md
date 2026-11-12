# Установка Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Загрузки](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Используйте код из приложения, чтобы добавить компьютер в нужную команду в Nessie. Проверьте разрешения, прежде чем агенты начнут работу.

## Linux

Скачайте подходящий пакет Linux со страницы выпусков и выполните команду из папки, в которую вы его сохранили.

Фоновые службы Linux требуют systemd. Пакеты содержат среду выполнения; APT или DNF устанавливает Git и tmux как зависимости.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

После установки откройте новый терминал и проверьте команду.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
