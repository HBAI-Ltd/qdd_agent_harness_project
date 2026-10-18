$ErrorActionPreference = 'Stop'
$sqbPidPath = Join-Path $PSScriptRoot '.local\shouqianba\server.pid'
if (-not (Test-Path -LiteralPath $sqbPidPath)) { Write-Output '没有收钱吧经营台启动记录'; exit }
$sqbProcessId = [int](Get-Content -LiteralPath $sqbPidPath -Raw)
$sqbRecordPath = Join-Path $PSScriptRoot '.local\shouqianba\server-process.json'
if (-not (Test-Path -LiteralPath $sqbRecordPath)) { throw '缺少本机进程验证记录，无法自动停止。' }
$sqbRecord = Get-Content -LiteralPath $sqbRecordPath -Raw | ConvertFrom-Json
$sqbProcess = Get-Process -Id $sqbProcessId -ErrorAction SilentlyContinue
$sqbExpected = Join-Path $PSScriptRoot 'sites\shouqianba-console\server.mjs'
if ($sqbProcess -and $sqbProcess.ProcessName -eq 'node' -and $sqbProcess.Path -eq $sqbRecord.node -and $sqbProcess.StartTime.ToUniversalTime().Ticks.ToString() -eq $sqbRecord.startTicks -and $sqbRecord.script -eq $sqbExpected -and $sqbRecord.pid -eq $sqbProcessId) {
  Stop-Process -Id $sqbProcessId
  Remove-Item -LiteralPath $sqbPidPath
  Write-Output '收钱吧经营台已停止'
} else { Write-Output '启动记录对应的进程已退出，或不属于收钱吧经营台' }
