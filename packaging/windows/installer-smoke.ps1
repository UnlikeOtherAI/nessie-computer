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
# no logon here, so the tray is started directly and must keep running.
$run = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name NessieExecutorTray
if (-not $run.NessieExecutorTray) {
  throw 'the tray autostart entry is missing'
}

$trayPath = Join-Path $env:ProgramFiles 'Nessie Executor\nessie-executor-tray.exe'

# The product is Nessie Computer wherever a person sees it; the service keeps
# its name, and the Start menu shortcut carries the app's toast identity.
$service = Get-CimInstance Win32_Service -Filter "Name='NessieExecutor'"
if ($service.DisplayName -ne 'Nessie Computer') {
  throw "the service is displayed as '$($service.DisplayName)'"
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Nessie Computer.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
  throw 'the Nessie Computer Start menu shortcut is missing'
}
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
if ($shortcut.TargetPath -ne $trayPath) {
  throw "the Start menu shortcut opens '$($shortcut.TargetPath)'"
}
$linkCommand = (Get-ItemProperty 'HKCU:\Software\Classes\nessie-computer\shell\open\command').'(default)'
if ($linkCommand -ne "`"$trayPath`" `"%1`"") {
  throw "nessie-computer links open '$linkCommand'"
}
if ($null -eq (Get-ItemProperty 'HKCU:\Software\Classes\nessie-computer' -Name 'URL Protocol' -ErrorAction SilentlyContinue)) {
  throw 'nessie-computer is not registered as a link scheme'
}

# A first launch with no team may open the app's own window on the pairing
# code; no other window may appear. Process.MainWindowTitle cannot tell: the
# framework keeps two helper windows that are WS_VISIBLE so they receive
# messages, but layered and never painted, so nobody sees them. They are
# matched exactly by class and title: tao's event target, and the
# single-instance helper named after the app identifier in tauri.conf.json.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NessieSmokeWindows {
  public sealed class TopLevelWindow {
    public string ClassName;
    public string Title;
  }

  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);

  public static List<TopLevelWindow> Visible(int processId) {
    var windows = new List<TopLevelWindow>();
    EnumWindows((window, parameter) => {
      uint windowProcessId;
      GetWindowThreadProcessId(window, out windowProcessId);
      if (windowProcessId != (uint)processId || !IsWindowVisible(window)) {
        return true;
      }
      var title = new StringBuilder(512);
      GetWindowText(window, title, title.Capacity);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      windows.Add(new TopLevelWindow { ClassName = className.ToString(), Title = title.ToString() });
      return true;
    }, IntPtr.Zero);
    return windows;
  }
}
'@
$appIdentifier = 'com.unlikeotherai.nessie.executor.tray'
$helperWindows = @(
  @{ ClassName = 'Tao Thread Event Target'; Title = '' },
  @{ ClassName = "$appIdentifier-sic"; Title = "$appIdentifier-siw" }
)

$tray = Start-Process -FilePath $trayPath -PassThru
try {
  Start-Sleep -Seconds 10
  $trayRunning = Get-Process -Id $tray.Id -ErrorAction SilentlyContinue
  if (-not $trayRunning) {
    throw 'the tray exited within ten seconds'
  }
  $unexpectedWindows = @(
    [NessieSmokeWindows]::Visible($tray.Id) | Where-Object {
      $window = $_
      $isHelper = @(
        $helperWindows | Where-Object {
          $_.ClassName -ceq $window.ClassName -and $_.Title -ceq $window.Title
        }
      ).Count -gt 0
      -not $isHelper -and $window.Title -cne 'Nessie Computer'
    }
  )
  if ($unexpectedWindows.Count -gt 0) {
    $described = ($unexpectedWindows | ForEach-Object { "'$($_.Title)' ($($_.ClassName))" }) -join ', '
    throw "the tray opened a window other than Nessie Computer at launch: $described"
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
if (Test-Path -LiteralPath $shortcutPath) {
  throw 'the Start menu shortcut was not removed'
}
if (Test-Path 'HKCU:\Software\Classes\nessie-computer') {
  throw 'the nessie-computer link registration was not removed'
}

# A pairing is a machine key and a signed policy revision, and uninstalling a
# program is not a request to destroy them.
if (-not (Test-Path $stateRoot)) {
  throw 'the state root was removed by uninstall'
}
