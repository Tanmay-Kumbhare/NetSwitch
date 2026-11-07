<#
 NetSwitch manual recovery. Run in an ADMINISTRATOR PowerShell if NetSwitch crashed or you need
 to restore your adapter metrics and remove temporary pinned probe routes.

 Usage: .\scripts\restore.ps1
        Reads netswitch-state.json (recorded before any OS metric change), restores original
        InterfaceMetric and AutomaticMetric settings for managed adapters only, removes pinned
        probe routes, verifies the restored configuration independently, and removes the state file.
#>
param(
  [string]$StateFile = (Join-Path $PSScriptRoot '..\netswitch-state.json'),
  [switch]$AutoAll
)

$ErrorActionPreference = 'Stop'

if ($AutoAll) {
  Write-Error "The -AutoAll parameter has been permanently disabled for safety. It altered VMware (VMnet1/VMnet8) and unrelated interfaces. NetSwitch restores only managed adapters recorded in the state file."
  exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "Run this script from an Administrator PowerShell."
  exit 1
}

$probeIps = @('1.1.1.1','1.0.0.1','8.8.8.8','8.8.4.4','9.9.9.10','149.112.112.10')

function Is-VirtualAdapter([string]$alias, [string]$desc) {
  $combined = "$alias $desc"
  return ($combined -match 'VMware|VMnet|VirtualBox|vEthernet|Hyper-V|Loopback|Npcap|TAP-|VPN|Tailscale|WireGuard')
}

$verifiedSuccess = $true
$restoredCount = 0

if (Test-Path $StateFile) {
  Write-Host "Reading state file: $StateFile"
  $rawContent = Get-Content $StateFile -Raw

  $s = $null
  try {
    $s = $rawContent | ConvertFrom-Json
  } catch {
    $backup = "$StateFile.corrupted.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Copy-Item $StateFile $backup -Force
    Write-Warning "State file was corrupted and could not be parsed. Created backup at: $backup"
    exit 1
  }

  if ($s.originals -and $s.originals.Count -gt 0) {
    foreach ($o in $s.originals) {
      if (Is-VirtualAdapter $o.alias $o.description) {
        Write-Warning "Skipping virtual / VMware adapter: $($o.alias) (Index $($o.index))"
        continue
      }

      try {
        if ($o.autoMetric) {
          Set-NetIPInterface -InterfaceIndex $o.index -AddressFamily IPv4 -AutomaticMetric Enabled
          Write-Host ("Restored {0} (index {1}) -> AutomaticMetric=Enabled" -f $o.alias, $o.index)
        } else {
          Set-NetIPInterface -InterfaceIndex $o.index -AddressFamily IPv4 -AutomaticMetric Disabled -InterfaceMetric $o.metric
          Write-Host ("Restored {0} (index {1}) -> InterfaceMetric={2}, AutomaticMetric=Disabled" -f $o.alias, $o.index, $o.metric)
        }
        $restoredCount++
      } catch {
        Write-Warning ("Failed to set metric on {0} (index {1}): {2}" -f $o.alias, $o.index, $_.Exception.Message)
        $verifiedSuccess = $false
      }
    }
  }

  # Remove pinned routes recorded in state
  if ($s.pinned -and $s.pinned.Count -gt 0) {
    foreach ($p in $s.pinned) {
      try {
        Remove-NetRoute -DestinationPrefix "$($p.ip)/32" -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Removed pinned probe route: $($p.ip)/32"
      } catch { /* ignore */ }
    }
  }

  # Also remove standard probe target host routes
  foreach ($ip in $probeIps) {
    Remove-NetRoute -DestinationPrefix "$ip/32" -Confirm:$false -ErrorAction SilentlyContinue
  }

  # Independent verification
  Write-Host "`nIndependently verifying restored interface metrics..."
  if ($s.originals) {
    foreach ($o in $s.originals) {
      if (Is-VirtualAdapter $o.alias $o.description) { continue }
      $cur = Get-NetIPInterface -InterfaceIndex $o.index -AddressFamily IPv4 -ErrorAction SilentlyContinue
      if ($cur) {
        $curAuto = ($cur.AutomaticMetric -eq 'Enabled')
        if ($o.autoMetric) {
          if (-not $curAuto) {
            Write-Warning "Verification mismatch on $($o.alias): expected AutoMetric=Enabled, got Disabled"
            $verifiedSuccess = $false
          }
        } else {
          if ($cur.InterfaceMetric -ne $o.metric -or $curAuto) {
            Write-Warning "Verification mismatch on $($o.alias): expected Metric=$($o.metric) Auto=Disabled, got Metric=$($cur.InterfaceMetric) Auto=$($cur.AutomaticMetric)"
            $verifiedSuccess = $false
          }
        }
      } else {
        Write-Warning "Could not query interface index $($o.index) for verification"
        $verifiedSuccess = $false
      }
    }
  }

  if ($verifiedSuccess) {
    Remove-Item $StateFile -Force
    Write-Host "All restored configurations independently verified. State file removed.`n"
  } else {
    Write-Warning "One or more restored settings could not be verified! Preserving state file at $StateFile for investigation.`n"
  }
} else {
  Write-Host "No state file found at $StateFile. Cleaning up any stray pinned probe routes..."
  foreach ($ip in $probeIps) {
    Remove-NetRoute -DestinationPrefix "$ip/32" -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host "Probe routes cleaned."
}

Write-Host "Current IPv4 interface metrics (excluding VMware and virtual adapters):"
Get-NetIPInterface -AddressFamily IPv4 |
  Where-Object { $_.ConnectionState -eq 'Connected' -and -not (Is-VirtualAdapter $_.InterfaceAlias '') } |
  Format-Table InterfaceAlias, InterfaceIndex, AutomaticMetric, InterfaceMetric
