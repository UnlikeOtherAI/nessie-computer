# Instalar o Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Transferências](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Use o código da aplicação para adicionar o computador à equipa pretendida no Nessie. Reveja as permissões antes de os agentes trabalharem.

## Linux

Descarregue o pacote Linux adequado da página de versões e execute o comando a partir da pasta onde o guardou.

Os serviços de fundo em Linux requerem systemd. Os pacotes incluem o runtime; o APT ou o DNF instalam o Git e o tmux como dependências.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Após a instalação, abra um novo terminal e verifique o comando.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
