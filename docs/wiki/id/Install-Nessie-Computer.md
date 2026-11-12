# Instal Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Unduhan](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Gunakan kode di aplikasi untuk menambahkan komputer ke tim yang diinginkan di Nessie. Tinjau izin akses sebelum agen bekerja.

## Linux

Unduh paket Linux yang sesuai dari halaman rilis, lalu jalankan perintah dari folder tempat Anda menyimpannya.

Layanan latar belakang Linux memerlukan systemd. Paket menyertakan runtime; APT atau DNF memasang Git dan tmux sebagai dependensi.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Setelah instalasi, buka terminal baru dan periksa perintahnya.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
