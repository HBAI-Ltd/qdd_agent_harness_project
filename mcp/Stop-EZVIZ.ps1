$ErrorActionPreference='Stop'
$ezvizPort=8791
if($env:EZVIZ_PORT){$ezvizPort=[int]$env:EZVIZ_PORT}
if($ezvizPort -lt 1024 -or $ezvizPort -gt 65535){throw 'Invalid EZVIZ_PORT.'}
$ezvizUrl="http://127.0.0.1:$ezvizPort"
$pidPath=Join-Path $PSScriptRoot '.local\ezviz-server.pid'
$expectedServer=Join-Path $PSScriptRoot 'apps\ezviz-console\local\server.mjs'
$ezvizProcessId=$null
if(Test-Path -LiteralPath $pidPath){
 $ezvizProcessId=[int](Get-Content -LiteralPath $pidPath)
 $ezvizProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$ezvizProcessId" -ErrorAction SilentlyContinue
 if($ezvizProcess -and $ezvizProcess.CommandLine -notmatch [regex]::Escape($expectedServer)){throw 'PID belongs to another program; it was not stopped.'}
}
$ezvizHealth=$null
try{$ezvizHealth=Invoke-RestMethod "$ezvizUrl/health" -TimeoutSec 2}catch{}
if(-not $ezvizHealth){
 if($ezvizProcessId -and (Get-Process -Id $ezvizProcessId -ErrorAction SilentlyContinue)){throw 'EZVIZ is not responding. It was not forcibly terminated.'}
 if(Test-Path -LiteralPath $pidPath){Remove-Item -LiteralPath $pidPath}
 Write-Host 'EZVIZ is not running.';exit 0
}
if($ezvizHealth.service -ne 'ezviz'){throw 'This port belongs to another service; no stop request was sent.'}
# The response is sent only after camera stop and local media cleanup are confirmed.
Invoke-RestMethod "$ezvizUrl/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 180 | Out-Null
if($ezvizProcessId){
 try{Wait-Process -Id $ezvizProcessId -Timeout 60 -ErrorAction Stop}catch{if(Get-Process -Id $ezvizProcessId -ErrorAction SilentlyContinue){throw 'EZVIZ is still completing camera stopping; it was not forcibly terminated.'}}
}else{
 for($attempt=0;$attempt -lt 120;$attempt++){
  Start-Sleep -Milliseconds 250
  try{Invoke-RestMethod "$ezvizUrl/health" -TimeoutSec 1 | Out-Null}catch{break}
 }
 try{$ezvizHealth=Invoke-RestMethod "$ezvizUrl/health" -TimeoutSec 1}catch{$ezvizHealth=$null}
 if($ezvizHealth){throw 'EZVIZ has not exited yet; it was not forcibly terminated.'}
}
if(Test-Path -LiteralPath $pidPath){Remove-Item -LiteralPath $pidPath}
Write-Host 'EZVIZ stopped.'
