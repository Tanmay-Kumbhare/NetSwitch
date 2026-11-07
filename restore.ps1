<#
 NetSwitch recovery shortcut. Delegates to scripts/restore.ps1.
#>
param(
  [string]$StateFile,
  [switch]$AutoAll
)

$targetScript = Join-Path $PSScriptRoot 'scripts\restore.ps1'
if (-not (Test-Path $targetScript)) {
  Write-Error "Cannot find recovery script at $targetScript"
  exit 1
}

$params = @{}
if ($PSBoundParameters.ContainsKey('StateFile')) { $params['StateFile'] = $StateFile }
if ($PSBoundParameters.ContainsKey('AutoAll')) { $params['AutoAll'] = $AutoAll }

& $targetScript @params
