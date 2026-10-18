$ErrorActionPreference = 'Stop'
$mcpPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$mcpPreviousNoOpen = $env:SQB_NO_OPEN
try {
  $env:SQB_NO_OPEN = '1'
  foreach ($mcpService in @('Shouqianba', 'TYSL', 'EZVIZ', 'HAIK')) {
    $mcpScript = Join-Path $PSScriptRoot "Start-$mcpService.ps1"
    $mcpArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $mcpScript)
    if ($mcpService -eq 'TYSL') { $mcpArguments += '-NoBrowser' }
    & $mcpPowerShell @mcpArguments
    if ($LASTEXITCODE -ne 0) { throw "$mcpService failed to start; see its local service logs." }
  }
} finally {
  $env:SQB_NO_OPEN = $mcpPreviousNoOpen
}
Write-Output 'All four local MCP services are running. Start or restart the QDD backend to load them.'
