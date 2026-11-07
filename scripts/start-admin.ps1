# Builds the frontend once (if needed) and starts the NetSwitch agent. Run from an ADMINISTRATOR PowerShell.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Warning 'Not running as Administrator: monitoring works, switching is disabled.' }
if (-not (Test-Path (Join-Path $root 'frontend\dist'))) { Push-Location (Join-Path $root 'frontend'); npm install; npm run build; Pop-Location }
Push-Location (Join-Path $root 'backend'); npm start; Pop-Location
