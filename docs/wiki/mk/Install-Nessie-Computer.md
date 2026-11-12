# Инсталирање на Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Преземања](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Со кодот од апликацијата додајте го компјутерот во саканиот тим во Nessie. Проверете ги дозволите пред агентите да почнат да работат.

## Linux

Преземете го соодветниот пакет за Linux од страницата со изданија и извршете ја командата од папката каде што го зачувавте.

Позадинските услуги на Linux бараат systemd. Пакетите го содржат извршувачкото окружување; APT или DNF ги инсталираат Git и tmux како зависности.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

По инсталацијата, отворете нов терминал и проверете ја командата.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
