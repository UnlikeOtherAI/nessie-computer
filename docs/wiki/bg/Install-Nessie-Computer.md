# Инсталиране на Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Изтегляния](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Използвайте кода от приложението, за да добавите компютъра към желания екип в Nessie. Проверете разрешенията, преди агентите да започнат работа.

## Linux

Изтеглете подходящия пакет за Linux от страницата с версии и изпълнете командата от папката, в която сте го записали.

Фоновите услуги на Linux изискват systemd. Пакетите включват изпълнимата среда; APT или DNF инсталират Git и tmux като зависимости.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

След инсталирането отворете нов терминал и проверете командата.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
