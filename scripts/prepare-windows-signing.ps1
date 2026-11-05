param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Microsoft documents extracting this package for SignTool. Pin the complete
# archive instead of resolving a WinGet source or waiting for an MSI installer.
$version = '1.0.146'
$expectedHash = '7761e5d8f31e54b764da21d33cd8b0a2940e1b05526c7dfcb5e94b0431426f70'
$uri = "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$version/microsoft.artifactsigning.client.$version.nupkg"
$directory = [System.IO.Path]::GetFullPath($DestinationDirectory)
if ($directory -match '[\r\n]' -or -not $env:GITHUB_ENV) {
  throw 'Artifact Signing preparation requires a safe directory and GITHUB_ENV.'
}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$archive = Join-Path $directory 'client.zip'
$client = Join-Path $directory 'client'

Invoke-WebRequest -Uri $uri -OutFile $archive -TimeoutSec 60 -UseBasicParsing
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw 'The Artifact Signing client archive did not match its pinned SHA-256.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $client -Force
$dlib = Join-Path $client 'bin\x64\Azure.CodeSigning.Dlib.dll'
if (-not (Test-Path -LiteralPath $dlib -PathType Leaf)) {
  throw 'The Artifact Signing client archive did not contain its x64 signing library.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $dlib
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
  throw 'The Artifact Signing library requires a valid Microsoft signature.'
}

"NESSIE_ARTIFACT_SIGNING_CLIENT_ROOT=$client" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "Prepared pinned Microsoft Artifact Signing client $version at $client."
