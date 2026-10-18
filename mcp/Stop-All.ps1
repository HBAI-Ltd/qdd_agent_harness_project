$ErrorActionPreference = 'Stop'
$mcpPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$mcpFailures = @()
foreach ($mcpService in @('HAIK', 'EZVIZ', 'TYSL', 'Shouqianba')) {
  & $mcpPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Stop-$mcpService.ps1")
  if ($LASTEXITCODE -ne 0) { $mcpFailures += $mcpService }
}
if ($mcpFailures.Count -gt 0) { throw "Could not stop: $($mcpFailures -join ', '). Check the service logs and retry." }
