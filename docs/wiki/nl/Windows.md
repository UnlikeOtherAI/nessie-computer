# Nessie Computer — Windows

[Nessie Computer installeren](Install-Nessie-Computer.md)

[Downloads: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

Vereist Windows 10 22H2 of nieuwer, x64. Open de MSI, keur de installatie goed en open Nessie Computer via Start. Het pictogram kan tussen de verborgen pictogrammen in het systeemvak staan.

Voeg de computer met de code uit de app toe aan het gewenste team in Nessie. Controleer de toegangsrechten voordat agenten aan het werk gaan.

Controleer vóór goedkeuring of de uitgever **UnlikeOtherAI s.r.o.** is. Open na de installatie een nieuw PowerShell-venster en controleer de geïnstalleerde opdracht:

```powershell
nessie-computer --version
nessie-computer --help
```

Laat lopend werk afronden voordat je bijwerkt en houd Nessie Computer open. Het installatieprogramma herstart de app en verwijdert oude verbindingsvergrendelingen alleen als Windows bevestigt dat het oorspronkelijke proces is beëindigd. Teaminstellingen en geschiedenis blijven behouden.
