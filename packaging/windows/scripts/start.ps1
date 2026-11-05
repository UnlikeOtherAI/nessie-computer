# Starts one session's guest virtual machine. Prints nothing.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$VmName)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Start-VM -Name $VmName | Out-Null
