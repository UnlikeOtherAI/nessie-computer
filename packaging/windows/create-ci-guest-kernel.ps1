[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is intentionally not a bootable kernel. The release workflow builds and
# boots the pinned Linux guest kernel; PR CI uses this fixed payload only to
# exercise the actual Windows MSI's staging and installer lifecycle.
$fixture = [System.Text.Encoding]::ASCII.GetBytes(
  "Nessie Windows Native CI fixture; deliberately non-bootable. Validates only executor MSI staging, WiX, install, service/tray launch, and uninstall.`0nessie.args=initrd`0"
)
$expectedSha256 = '990b0c0d7705e52f2b308d142121b90f33699e64de0e2cf8f144eaf17255be34'
$absoluteOutputPath = [System.IO.Path]::GetFullPath($OutputPath)

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $absoluteOutputPath) | Out-Null
[System.IO.File]::WriteAllBytes($absoluteOutputPath, $fixture)

$actualSha256 = (Get-FileHash -LiteralPath $absoluteOutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "the Windows Native guest-kernel fixture checksum was $actualSha256, expected $expectedSha256"
}

$fixtureText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($absoluteOutputPath))
if ($fixtureText -notmatch 'nessie\.args=initrd') {
  throw 'the Windows Native guest-kernel fixture carries no Nessie command line marker'
}
