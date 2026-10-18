$ErrorActionPreference = 'Stop'
$sqbRoot = $PSScriptRoot
$sqbRuntime = Join-Path $sqbRoot '.local\shouqianba'
New-Item -ItemType Directory -Force -Path $sqbRuntime | Out-Null
$sqbRunning = $false
try {
  $sqbHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/health' -TimeoutSec 3
  if ($sqbHealth.service -eq 'shouqianba') { $sqbRunning = $true }
} catch {}
if (-not $sqbRunning) {
  $sqbNode = (Get-Command node.exe -ErrorAction Stop).Source
  $sqbScript = Join-Path $sqbRoot 'sites\shouqianba-console\server.mjs'
  $sqbProcess = Start-Process -FilePath $sqbNode -ArgumentList @('--use-env-proxy', ('"' + $sqbScript + '"')) -WorkingDirectory $sqbRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sqbRuntime 'server.log') -RedirectStandardError (Join-Path $sqbRuntime 'error.log') -PassThru
  $sqbProcess.Id | Set-Content -LiteralPath (Join-Path $sqbRuntime 'server.pid')
  @{ pid=$sqbProcess.Id; startTicks=$sqbProcess.StartTime.ToUniversalTime().Ticks.ToString(); node=$sqbProcess.Path; script=$sqbScript } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sqbRuntime 'server-process.json')
  for ($sqbAttempt = 0; $sqbAttempt -lt 30; $sqbAttempt++) {
    Start-Sleep -Milliseconds 200
    try {
      $sqbHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/health' -TimeoutSec 1
      if ($sqbHealth.service -eq 'shouqianba') { $sqbRunning = $true; break }
    } catch {}
  }
  if (-not $sqbRunning) { throw '收钱吧经营台未能启动，请检查 .local\shouqianba\error.log' }
}
Write-Output '收钱吧经营台：http://127.0.0.1:8788'
if ($env:SQB_NO_OPEN -ne '1') { Start-Process 'http://127.0.0.1:8788' }
