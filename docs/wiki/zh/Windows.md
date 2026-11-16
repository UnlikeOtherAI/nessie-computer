# Nessie Computer — Windows

[安装 Nessie Computer](Install-Nessie-Computer.md)

[下载: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

需要 Windows 10 22H2 或更高版本，x64。打开 MSI，批准安装，然后从开始菜单打开 Nessie Computer。图标可能位于通知区域的隐藏图标中。

使用应用中显示的代码，将此电脑添加到 Nessie 中所需的团队。让智能体开始工作前，请检查访问权限。

批准前，请确认发布者为 **UnlikeOtherAI s.r.o.**。安装后，打开一个新的 PowerShell 窗口并检查已安装的命令：

```powershell
nessie-computer --version
nessie-computer --help
```

更新前，请等待正在进行的工作完成。只有在 Windows 确认原进程已结束后，Nessie Computer 安装程序才会移除旧的连接锁。团队设置和历史记录会保留。
