# Deletes one session's guest virtual machine and its configuration files.
# Prints nothing, and a machine that is already gone is success.
#
# `Remove-VM` deletes the virtual machine and its configuration; the disks stay
# where they are, and the daemon removes the whole session disk directory after
# this returns. A surviving disk is a surviving copy of the workspace, so
# neither half is optional.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$VmName)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if ($null -eq $vm) { return }

if ($vm.State -ne 'Off') {
  Stop-VM -VM $vm -TurnOff -Force | Out-Null
}
Remove-VM -VM $vm -Force | Out-Null
