# Stops one session's guest virtual machine. Prints nothing, and a machine that
# is already gone is success: stop is called on every failure path.
#
# `Stop-VM` with no switch asks the guest operating system to shut itself down,
# and `-Force` only stops waiting for applications to save their data — both
# are requests made through the shutdown integration service. This guest is an
# initramfs with no integration services at all, so nobody inside it would ever
# answer: the *graceful* path is the daemon closing the control channel, whose
# EOF returns the guest's init, exactly as under Firecracker. `-TurnOff`, which
# Microsoft documents as "equivalent to disconnecting the power from the
# virtual machine", is what the daemon's ten-second timeout falls to.
#
# `shutdown` stays available because a future guest that does run hv_utils
# should be asked politely first.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$VmName,
  [Parameter(Mandatory = $true)][ValidateSet('shutdown', 'turnoff')][string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if ($null -eq $vm) { return }
if ($vm.State -eq 'Off') { return }

if ($Mode -eq 'turnoff') {
  Stop-VM -VM $vm -TurnOff -Force | Out-Null
} else {
  Stop-VM -VM $vm -Force | Out-Null
}
