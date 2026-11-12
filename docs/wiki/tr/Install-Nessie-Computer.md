# Nessie Computer kurulumu

[macOS](Mac.md) · [Windows](Windows.md)

[İndirmeler](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Uygulamadaki kodu kullanarak bilgisayarı Nessie’de istediğiniz takıma ekleyin. Ajanlar çalışmadan önce erişim izinlerini gözden geçirin.

## Linux

Sürümler sayfasından uygun Linux paketini indirin, ardından komutu paketi kaydettiğiniz klasörden çalıştırın.

Linux arka plan hizmetleri systemd gerektirir. Paketler çalışma zamanını içerir; APT ya da DNF, Git ve tmux’u bağımlılık olarak kurar.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Kurulumdan sonra yeni bir terminal açın ve komutu kontrol edin.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
