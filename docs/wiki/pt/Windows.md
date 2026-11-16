# Nessie Computer — Windows

[Instalar o Nessie Computer](Install-Nessie-Computer.md)

[Transferências: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

Requer Windows 10 22H2 ou posterior, x64. Abra o MSI, autorize a instalação e abra o Nessie Computer no menu Iniciar. O ícone pode estar entre os ícones ocultos da área de notificação.

Use o código da aplicação para adicionar o computador à equipa pretendida no Nessie. Reveja as permissões antes de os agentes trabalharem.

Antes de aprovar, confirme que o editor é **UnlikeOtherAI s.r.o.**. Após a instalação, abra uma nova janela do PowerShell e verifique o comando instalado:

```powershell
nessie-computer --version
nessie-computer --help
```

Antes de atualizar, aguarde a conclusão do trabalho em curso. O instalador do Nessie Computer remove os bloqueios de ligações antigas apenas quando o Windows confirma que o processo original terminou. As definições e o histórico das equipas são preservados.
