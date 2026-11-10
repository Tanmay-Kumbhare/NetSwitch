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

      # Validate adapter identity before restoring metric
      if ($o.guid -or $o.mac) {
        $hw = Get-NetAdapter -InterfaceIndex $o.index -ErrorAction SilentlyContinue
        if (-not $hw) {
          Write-Warning "Recovery refused on index $($o.index) ($($o.alias)): adapter identity query failed or adapter unavailable"
          $verifiedSuccess = $false
          continue
        }
        if ($o.guid -and ($hw.InterfaceGuid -ne $o.guid)) {
          Write-Warning "Recovery refused on index $($o.index) ($($o.alias)): GUID mismatch (expected $($o.guid), actual $($hw.InterfaceGuid))"
          $verifiedSuccess = $false
          continue
        }
        if ($o.mac -and ($hw.MacAddress -and ($hw.MacAddress.ToLower() -ne $o.mac.ToLower()))) {
          Write-Warning "Recovery refused on index $($o.index) ($($o.alias)): MAC mismatch (expected $($o.mac), actual $($hw.MacAddress))"
          $verifiedSuccess = $false
          continue
        }
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

  # Remove owned pinned routes recorded in state (FAIL-CLOSED: never destination-only)
  if ($s.pinned -and $s.pinned.Count -gt 0) {
    foreach ($p in $s.pinned) {
      $targetIp = if ($p.ip) { $p.ip } else { ($p.prefix -split '/')[0] }
      if (-not $targetIp -or -not $p.index) {
        Write-Warning "Skipping invalid route record: missing target IP or interface index"
        continue
      }

      # Validate adapter identity if recorded
      if ($p.guid -or $p.mac) {
        $hw = Get-NetAdapter -InterfaceIndex $p.index -ErrorAction SilentlyContinue
        if (-not $hw -or ($p.guid -and $hw.InterfaceGuid -ne $p.guid) -or ($p.mac -and $hw.MacAddress.ToLower() -ne $p.mac.ToLower())) {
          Write-Warning "Route cleanup refused for $targetIp/32 on index $($p.index): adapter identity changed or unavailable"
          $verifiedSuccess = $false
          continue
        }
      }

      try {
        $ownedRoutes = Get-NetRoute -DestinationPrefix "$targetIp/32" -InterfaceIndex $p.index -ErrorAction SilentlyContinue
        if ($ownedRoutes) {
          $matches = @($ownedRoutes | Where-Object { (-not $p.gateway -or -not $_.NextHop -or $_.NextHop -eq $p.gateway) })
          if ($matches.Count -eq 1) {
            $removeArgs = @{
              DestinationPrefix = "$targetIp/32"
              InterfaceIndex = $p.index
              Confirm = $false
              ErrorAction = 'SilentlyContinue'
            }
            if ($p.gateway -and $p.gateway -ne '0.0.0.0') {
              $removeArgs['NextHop'] = $p.gateway
            }
            Remove-NetRoute @removeArgs
            Write-Host "Removed owned pinned probe route: $targetIp/32 on interface index $($p.index)"
          } elseif ($matches.Count -gt 1) {
            Write-Warning "Ambiguous route ownership for $targetIp/32 on index $($p.index): multiple matching routes found; preserving route."
            $verifiedSuccess = $false
          } else {
            Write-Warning "Preserving unrelated route for $targetIp/32 on index $($p.index): gateway does not match owned NetSwitch route record"
          }
        }
      } catch {
        Write-Warning "Error querying route for $targetIp/32 on index $($p.index): $($_.Exception.Message)"
        $verifiedSuccess = $false
      }
    }
  }

  # Independent verification of route deletion
  Write-Host "`nIndependently verifying probe route removal..."
  if ($s.pinned) {
    foreach ($p in $s.pinned) {
      $tip = if ($p.ip) { $p.ip } else { ($p.prefix -split '/')[0] }
      if ($tip -and $p.index) {
        $remaining = Get-NetRoute -DestinationPrefix "$tip/32" -InterfaceIndex $p.index -ErrorAction SilentlyContinue
        if ($remaining) {
          Write-Warning "Verification failure: Route $tip/32 on interface $($p.index) is still present in Windows routing table after cleanup!"
          $verifiedSuccess = $false
        }
      }
    }
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
  Write-Host "No state file found at $StateFile. Zero network changes made."
}

Write-Host "Current IPv4 interface metrics (excluding VMware and virtual adapters):"
Get-NetIPInterface -AddressFamily IPv4 |
  Where-Object { $_.ConnectionState -eq 'Connected' -and -not (Is-VirtualAdapter $_.InterfaceAlias '') } |
  Format-Table InterfaceAlias, InterfaceIndex, AutomaticMetric, InterfaceMetric
