[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,
  [switch]$RequireSignedService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
  throw "the executor MSI was not found at $PackagePath"
}

$installLog = Join-Path $PWD 'msi-install.log'
$install = Start-Process msiexec `
  -ArgumentList "/i `"$PackagePath`" /qn /norestart /l*v `"$installLog`"" `
  -Wait -PassThru
if ($install.ExitCode -ne 0) {
  Get-Content $installLog -Tail 80 -ErrorAction SilentlyContinue
  throw "the executor MSI install failed with code $($install.ExitCode)"
}

$service = Get-CimInstance Win32_Service -Filter "Name='NessieExecutor'"
if (-not $service) {
  Get-Content $installLog -Tail 60 -ErrorAction SilentlyContinue
  throw 'the service was not registered'
}
if ($service.StartName -ne 'NT SERVICE\NessieExecutor') {
  throw "the service runs as $($service.StartName)"
}
if ($service.StartMode -ne 'Auto') {
  throw 'the service does not start at boot'
}

# A signed release supervises; an unsigned development build keeps the service
# running and refuses in words, which is the behaviour the tamper case depends
# on.
if ($RequireSignedService) {
  if ($service.State -ne 'Running') {
    throw 'the service is not running'
  }
} else {
  Write-Host "unsigned build: service state is $($service.State)"
}

$stateRoot = Join-Path $env:ProgramData 'Nessie Executor'
if (-not (Test-Path $stateRoot)) {
  throw 'the state root was not created'
}

$stateAcl = Get-Acl $stateRoot
$stateAcl.Access | Format-Table IdentityReference, FileSystemRights, IsInherited
if ($RequireSignedService) {
  $serviceAccount = New-Object System.Security.Principal.NTAccount('NT SERVICE', 'NessieExecutor')
  $serviceSid = $serviceAccount.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $systemSid = 'S-1-5-18'
  $ownerSid = (New-Object System.Security.Principal.NTAccount($stateAcl.Owner)).Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
  if ($ownerSid -ne $serviceSid) {
    throw "the state root owner is $ownerSid instead of the executor service"
  }
  if ($stateAcl.AreAccessRulesProtected -ne $true) {
    throw 'the state root inherits access rules from ProgramData'
  }
  $stateRules = @($stateAcl.Access)
  if ($stateRules.Count -ne 2) {
    throw "the state root has $($stateRules.Count) access rules instead of two"
  }
  foreach ($rule in $stateRules) {
    $ruleSid = $rule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
    if ($ruleSid -notin @($serviceSid, $systemSid)) {
      throw "the state root grants access to unexpected identity $ruleSid"
    }
    if ($rule.IsInherited) {
      throw "the state root has an inherited rule for $ruleSid"
    }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      throw "the state root has a deny rule for $ruleSid"
    }
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
      throw "the state root does not grant full control to $ruleSid"
    }
  }
}

# The Run entry starts the tray at the installing user's next logon; there is
# no logon here, so the tray is started directly and must survive with no
# window of its own.
$run = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name NessieExecutorTray
if (-not $run.NessieExecutorTray) {
  throw 'the tray autostart entry is missing'
}

$trayPath = Join-Path $env:ProgramFiles 'Nessie Executor\nessie-executor-tray.exe'
$tray = Start-Process -FilePath $trayPath -PassThru
try {
  Start-Sleep -Seconds 10
  $trayRunning = Get-Process -Id $tray.Id -ErrorAction SilentlyContinue
  if (-not $trayRunning) {
    throw 'the tray exited within ten seconds'
  }
  $trayRunning.Refresh()
  if ($trayRunning.MainWindowTitle -ne '') {
    throw "the tray opened a window at launch: '$($trayRunning.MainWindowTitle)'"
  }
} finally {
  $trayRunning = Get-Process -Id $tray.Id -ErrorAction SilentlyContinue
  if ($trayRunning) {
    Stop-Process -Id $tray.Id -Force
  }
}

$uninstallLog = Join-Path $PWD 'msi-uninstall.log'
$uninstall = Start-Process msiexec `
  -ArgumentList "/x `"$PackagePath`" /qn /norestart /l*v `"$uninstallLog`"" `
  -Wait -PassThru
if ($uninstall.ExitCode -ne 0) {
  Get-Content $uninstallLog -Tail 80 -ErrorAction SilentlyContinue
  throw "the executor MSI uninstall failed with code $($uninstall.ExitCode)"
}
if (Get-Service NessieExecutor -ErrorAction SilentlyContinue) {
  throw 'the service was not removed'
}
if (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name NessieExecutorTray -ErrorAction SilentlyContinue) {
  throw 'the tray autostart entry was not removed'
}

# A pairing is a machine key and a signed policy revision, and uninstalling a
# program is not a request to destroy them.
if (-not (Test-Path $stateRoot)) {
  throw 'the state root was removed by uninstall'
}
