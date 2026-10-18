$ErrorActionPreference='Stop'
$haikPort=8787
if($env:HAIK_PORT){$haikPort=[int]$env:HAIK_PORT}
if($haikPort -lt 1024 -or $haikPort -gt 65535){throw 'Invalid HAIK_PORT.'}
$haikUrl="http://127.0.0.1:$haikPort"
$pidPath=Join-Path $PSScriptRoot '.local\server.pid'
$expectedServer=Join-Path $PSScriptRoot 'sites\haik-console\local\server.mjs'
$haikProcessId=$null
if(Test-Path -LiteralPath $pidPath){
 $haikProcessId=[int](Get-Content -LiteralPath $pidPath)
 $haikProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$haikProcessId" -ErrorAction SilentlyContinue
 if($haikProcess -and $haikProcess.CommandLine -notmatch [regex]::Escape($expectedServer)){throw 'PID belongs to another program; it was not stopped.'}
}
$haikHealth=$null
try{$haikHealth=Invoke-RestMethod "$haikUrl/health" -TimeoutSec 2}catch{}
if(-not $haikHealth){
 if($haikProcessId -and (Get-Process -Id $haikProcessId -ErrorAction SilentlyContinue)){throw 'HAIK is not responding. It was not forcibly terminated.'}
 if(Test-Path -LiteralPath $pidPath){Remove-Item -LiteralPath $pidPath}
 Write-Host 'HAIK is not running.';exit 0
}
if($haikHealth.service -ne 'haik'){throw 'This port belongs to another service; no stop request was sent.'}
# The response is sent only after camera stop and local media cleanup are confirmed.
Invoke-RestMethod "$haikUrl/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 180 | Out-Null
if($haikProcessId){
 try{Wait-Process -Id $haikProcessId -Timeout 60 -ErrorAction Stop}catch{if(Get-Process -Id $haikProcessId -ErrorAction SilentlyContinue){throw 'HAIK is still completing camera stopping; it was not forcibly terminated.'}}
}else{
 for($attempt=0;$attempt -lt 120;$attempt++){
  Start-Sleep -Milliseconds 250
  try{Invoke-RestMethod "$haikUrl/health" -TimeoutSec 1 | Out-Null}catch{break}
 }
 try{$haikHealth=Invoke-RestMethod "$haikUrl/health" -TimeoutSec 1}catch{$haikHealth=$null}
 if($haikHealth){throw 'HAIK has not exited yet; it was not forcibly terminated.'}
}
if(Test-Path -LiteralPath $pidPath){Remove-Item -LiteralPath $pidPath}
Write-Host 'HAIK stopped.'
