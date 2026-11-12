# Instalar Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Descargas](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Use el código de la aplicación para añadir este ordenador al equipo deseado en Nessie. Revise los permisos antes de que trabajen los agentes.

## Linux

Descarga el paquete de Linux correspondiente de la página de versiones y ejecuta el comando desde la carpeta donde lo guardaste.

Los servicios de segundo plano de Linux requieren systemd. Los paquetes incluyen el entorno de ejecución; APT o DNF instalan Git y tmux como dependencias.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Tras la instalación, abre un terminal nuevo y comprueba el comando.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
