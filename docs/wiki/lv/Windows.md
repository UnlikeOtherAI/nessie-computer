# Nessie Computer — Windows

[Nessie Computer instalēšana](Install-Nessie-Computer.md)

[Lejupielādes: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

Nepieciešams Windows 10 22H2 vai jaunāka versija, x64. Atveriet MSI, apstipriniet instalēšanu un atveriet Nessie Computer izvēlnē Sākt. Ikona var būt starp paziņojumu apgabala paslēptajām ikonām.

Izmantojiet lietotnē redzamo kodu, lai pievienotu datoru vēlamajai Nessie komandai. Pārbaudiet piekļuves atļaujas, pirms aģenti sāk darbu.

Pirms apstiprināšanas pārbaudiet, vai izdevējs ir **UnlikeOtherAI s.r.o.**. Pēc instalēšanas atveriet jaunu PowerShell logu un pārbaudiet instalēto komandu:

```powershell
nessie-computer --version
nessie-computer --help
```
