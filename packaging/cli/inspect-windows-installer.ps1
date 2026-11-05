param([Parameter(Mandatory = $true)][string] $Path)
$ErrorActionPreference = 'Stop'
if (-not $env:WINDOWS_SIGNER_EKU -or -not $env:WINDOWS_SIGNER_SUBJECT) {
  throw 'Set WINDOWS_SIGNER_EKU and WINDOWS_SIGNER_SUBJECT from the existing Azure Artifact Signing configuration.'
}
if ($env:WINDOWS_SIGNER_EKU -eq '1.3.6.1.4.1.311.97.1.0' -or
    $env:WINDOWS_SIGNER_EKU.StartsWith('1.3.6.1.4.1.311.97.2')) {
  throw 'The shared Public Trust marker and Private Trust profiles are not a Nessie publisher pin.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $Path
$ekus = @($signature.SignerCertificate.Extensions |
  Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
  ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
if ($signature.Status -ne 'Valid' -or $env:WINDOWS_SIGNER_EKU -notin $ekus -or
    $signature.SignerCertificate.Subject -notlike "*$env:WINDOWS_SIGNER_SUBJECT*") {
  throw 'The installer must carry a valid signature from the configured Nessie Artifact Signing profile.'
}
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase((Resolve-Path -LiteralPath $Path).Path, 0)
function Read-MsiProperty([string] $Name) {
  $view = $database.OpenView("SELECT Value FROM Property WHERE Property = '$Name'")
  $view.Execute()
  $record = $view.Fetch()
  if (-not $record) { throw "Missing MSI property: $Name" }
  $result = $record.StringData(1)
  $view.Close()
  return $result
}
if ((Read-MsiProperty 'ProductName') -ne 'Nessie Executor' -or
    (Read-MsiProperty 'Manufacturer') -ne 'UnlikeOtherAI') { throw 'This MSI is not Nessie Executor.' }
@{ version = Read-MsiProperty 'ProductVersion'; productCode = Read-MsiProperty 'ProductCode' } | ConvertTo-Json -Compress
