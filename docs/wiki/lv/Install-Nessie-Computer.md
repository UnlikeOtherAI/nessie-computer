# Nessie Computer instalēšana

[macOS](Mac.md) · [Windows](Windows.md)

[Lejupielādes](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Izmantojiet lietotnē redzamo kodu, lai pievienotu datoru vēlamajai Nessie komandai. Pārbaudiet piekļuves atļaujas, pirms aģenti sāk darbu.

## Linux

Lejupielādējiet atbilstošo Linux pakotni no laidienu lapas un izpildiet komandu mapē, kurā to saglabājāt.

Linux fona pakalpojumiem nepieciešams systemd. Pakotnes ietver izpildlaiku; APT vai DNF instalē Git un tmux kā atkarības.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Pēc instalēšanas atveriet jaunu termināli un pārbaudiet komandu.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
