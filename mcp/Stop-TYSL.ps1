$ErrorActionPreference='Stop'
$tyslPort=8790
if($env:TYSL_PORT){$tyslPort=[int]$env:TYSL_PORT}
$tyslUrl="http://127.0.0.1:$tyslPort"
try{$tyslHealth=Invoke-RestMethod -Uri "$tyslUrl/health" -TimeoutSec 2}catch{Write-Output '天翼视联本地服务未运行。';exit 0}
if($tyslHealth.service -ne 'tysl'){throw '此端口不是天翼视联服务，未执行停止。'}
Invoke-RestMethod -Method Post -Uri "$tyslUrl/shutdown" -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
for($tyslAttempt=0;$tyslAttempt -lt 60;$tyslAttempt++){
  Start-Sleep -Milliseconds 250
  try{Invoke-RestMethod -Uri "$tyslUrl/health" -TimeoutSec 1 | Out-Null}catch{Write-Output '天翼视联本地服务已停止。';exit 0}
}
throw '服务仍在确认云台停止或关闭视频，请稍后再停止；未强制结束进程。'
