param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'scripts\start-tysl.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $NoBrowser) {
  $tyslPort = if ($env:TYSL_PORT) { [int]$env:TYSL_PORT } else { 8790 }
  Start-Process "http://127.0.0.1:$tyslPort/"
}
