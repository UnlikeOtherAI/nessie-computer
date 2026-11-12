# Встановлення Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Завантаження](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Використайте код із програми, щоб додати комп’ютер до потрібної команди в Nessie. Перевірте дозволи, перш ніж агенти почнуть працювати.

## Linux

Завантажте відповідний пакет Linux зі сторінки випусків і виконайте команду з папки, у якій його зберегли.

Фонові служби Linux потребують systemd. Пакети містять середовище виконання; APT або DNF встановлює Git і tmux як залежності.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Після встановлення відкрийте новий термінал і перевірте команду.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
