# Nessie Computer — Windows

[Инсталиране на Nessie Computer](Install-Nessie-Computer.md)

[Изтегляния: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

Изисква Windows 10 22H2 или по-нова версия, x64. Отворете MSI, разрешете инсталирането и отворете Nessie Computer от Старт. Иконата може да е сред скритите икони в областта за уведомяване.

Използвайте кода от приложението, за да добавите компютъра към желания екип в Nessie. Проверете разрешенията, преди агентите да започнат работа.

Преди да одобрите, проверете дали издателят е **UnlikeOtherAI s.r.o.**. След инсталирането отворете нов прозорец на PowerShell и проверете инсталираната команда:

```powershell
nessie-computer --version
nessie-computer --help
```

При обновяване изчакайте текущата работа да приключи и оставете Nessie Computer отворено. Инсталаторът рестартира приложението и премахва старите заключвания на връзките само след като Windows потвърди, че първоначалният процес е приключил. Настройките и историята на екипите се запазват.
