param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$tyslRoot=$PSScriptRoot
$tyslPort=8790
if($env:TYSL_PORT){$tyslPort=[int]$env:TYSL_PORT}
$tyslUrl="http://127.0.0.1:$tyslPort"
function Get-TyslHealth {try {Invoke-RestMethod -Uri "$tyslUrl/health" -TimeoutSec 2} catch {$null}}
$tyslHealth=Get-TyslHealth
if($tyslHealth -and $tyslHealth.service -ne 'tysl'){throw '端口已由其他服务使用。'}
if(-not $tyslHealth){
  $tyslNode=(Get-Command node -ErrorAction Stop).Source
  $tyslServer=Join-Path $tyslRoot 'apps\tysl-console\local\server.mjs'
  $tyslLocal=Join-Path $tyslRoot '.local'
  $tyslFfmpeg=Join-Path $tyslRoot 'tools\node_modules\ffmpeg-static\ffmpeg.exe'
  if($env:TYSL_FFMPEG){$tyslFfmpeg=$env:TYSL_FFMPEG}
  if(-not (Test-Path -LiteralPath $tyslFfmpeg)){throw '缺少 FFmpeg，请先运行 npm run setup 或配置 TYSL_FFMPEG。'}
  New-Item -ItemType Directory -Path $tyslLocal -Force | Out-Null
  $tyslProcess=Start-Process -FilePath $tyslNode -ArgumentList @('"'+$tyslServer+'"') -WorkingDirectory $tyslRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $tyslLocal 'tysl-service.out.log') -RedirectStandardError (Join-Path $tyslLocal 'tysl-service.err.log') -PassThru
  Set-Content -LiteralPath (Join-Path $tyslLocal 'tysl-service.pid') -Value $tyslProcess.Id -Encoding ascii
  for($tyslAttempt=0;$tyslAttempt -lt 50;$tyslAttempt++){
    Start-Sleep -Milliseconds 200
    $tyslHealth=Get-TyslHealth
    if($tyslHealth -and $tyslHealth.service -eq 'tysl'){break}
    if($tyslProcess.HasExited){throw '天翼视联本地服务启动失败，请检查 .local\tysl-service.err.log。'}
  }
  if(-not $tyslHealth){throw '本地服务尚未就绪，请稍后重试。'}
}
Write-Output "天翼视联本地网页：$tyslUrl/"
Write-Output "独立 MCP：$tyslUrl/mcp"
if(-not $NoBrowser){Start-Process $tyslUrl}
