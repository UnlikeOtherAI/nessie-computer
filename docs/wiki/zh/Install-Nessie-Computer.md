# 安装 Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[下载](https://github.com/UnlikeOtherAI/nessie-computer/releases)

使用应用中显示的代码，将此电脑添加到 Nessie 中所需的团队。让智能体开始工作前，请检查访问权限。

## Linux

从发布页面下载对应的 Linux 软件包，然后在保存软件包的文件夹中运行命令。

Linux 后台服务需要 systemd。软件包内含运行时；APT 或 DNF 会将 Git 和 tmux 作为依赖一并安装。

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

安装后，打开新的终端并检查命令。

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
