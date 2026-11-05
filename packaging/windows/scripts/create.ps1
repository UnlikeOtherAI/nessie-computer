# Creates one session's guest virtual machine.
#
# Installed root-owned under Program Files and pinned by SHA-256 in the
# package's resources/manifest.json; the daemon refuses to run a script whose
# bytes differ. Every value arrives as a script parameter through
# `powershell.exe -File`, never inside a composed command string.
#
# Cmdlets and their documented behaviour (Microsoft Learn, Hyper-V module):
#   New-VM                  -Generation 2, -MemoryStartupBytes, -NoVHD, -Path.
#                           "Hyper-V automatically creates a virtual machine
#                           with one virtual network adapter" — which is why one
#                           is removed below rather than simply not connected.
#   Convert-VHD             "Can I attach a virtual hard disk in VHD format to a
#                           generation 2 virtual machine? No. Generation 2
#                           virtual machines only support VHDX format virtual
#                           hard drives." The daemon builds fixed VHDs without
#                           privilege; this is where they become VHDX.
#   Add-VMHardDiskDrive     -ControllerType SCSI is the only bus a generation 2
#                           machine has: "The virtual Integrated Device
#                           Electronics (IDE) controller is not available in
#                           generation 2 virtual machines."
#   Set-VMFirmware          -EnableSecureBoot Off: "Generation 2 Linux virtual
#                           machines will not boot unless the secure boot option
#                           is disabled." Our kernel is built here and signed by
#                           nobody in the UEFI database, so Secure Boot could
#                           never accept it.
#   Set-VMComPort           -Number 1 -Path \\.\pipe\...: Hyper-V connects to
#                           that pipe as a client, so the daemon is listening on
#                           it before this runs.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$VmName,
  [Parameter(Mandatory = $true)][string]$VmPath,
  [Parameter(Mandatory = $true)][int]$MemoryMiB,
  [Parameter(Mandatory = $true)][int]$VcpuCount,
  [Parameter(Mandatory = $true)][string]$BootDiskVhd,
  [Parameter(Mandatory = $true)][string]$RuntimeDiskVhd,
  [Parameter(Mandatory = $true)][string]$WorkspaceDiskVhd,
  [Parameter(Mandatory = $true)][string]$DraftDiskVhd,
  [Parameter(Mandatory = $true)][string]$ConsolePipe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-FixedVhdx {
  param([string]$Path)
  $destination = [System.IO.Path]::ChangeExtension($Path, '.vhdx')
  Convert-VHD -Path $Path -DestinationPath $destination -VHDType Fixed -DeleteSource | Out-Null
  return $destination
}

$boot = ConvertTo-FixedVhdx -Path $BootDiskVhd
$runtime = ConvertTo-FixedVhdx -Path $RuntimeDiskVhd
$workspace = ConvertTo-FixedVhdx -Path $WorkspaceDiskVhd
$draft = ConvertTo-FixedVhdx -Path $DraftDiskVhd

$vm = New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ([int64]$MemoryMiB * 1MB) -NoVHD -Path $VmPath

# No network adapter at all. The guest's only route off this machine is the
# forced-egress gateway over a Hyper-V socket, exactly as under every other
# hypervisor; leaving a disconnected adapter would make that a configuration
# choice rather than a structural fact.
Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter

Set-VMProcessor -VM $vm -Count $VcpuCount
Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
# A checkpoint would write the session's workspace to a file that outlives the
# session, and an automatic start action would boot a dead session at reboot.
Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -CheckpointType Disabled `
  -AutomaticStartAction Nothing -AutomaticStopAction TurnOff
Set-VMFirmware -VM $vm -EnableSecureBoot Off

# The attach order is fixed so two runs look the same to a person reading
# Get-VMHardDiskDrive. The guest does not read these positions: Linux names
# hv_storvsc disks as they finish probing, so it finds each image by its ext4
# label (executor/guest/mounts_linux.go).
$bootDrive = Add-VMHardDiskDrive -VM $vm -ControllerType SCSI -ControllerNumber 0 `
  -ControllerLocation 0 -Path $boot -Passthru
Add-VMHardDiskDrive -VM $vm -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 1 -Path $runtime
Add-VMHardDiskDrive -VM $vm -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 2 -Path $workspace
Add-VMHardDiskDrive -VM $vm -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 3 -Path $draft

Set-VMFirmware -VM $vm -FirstBootDevice $bootDrive
Set-VMComPort -VM $vm -Number 1 -Path $ConsolePipe

# The only thing this script prints. The daemon parses exactly this, so a VM id
# is never scraped out of prose a localized Windows would translate.
@{ vmId = $vm.Id.Guid } | ConvertTo-Json -Compress
