$ErrorActionPreference='Stop'
$ezvizRoot=$PSScriptRoot
$ezvizPort=8791
if($env:EZVIZ_PORT){$ezvizPort=[int]$env:EZVIZ_PORT}
if($ezvizPort -lt 1024 -or $ezvizPort -gt 65535){throw 'Invalid EZVIZ_PORT.'}
$ezvizUrl="http://127.0.0.1:$ezvizPort"
$projectRoot=Join-Path $ezvizRoot 'apps\ezviz-console'
$serverPath=Join-Path $projectRoot 'local\server.mjs'
$localState=Join-Path $ezvizRoot '.local'
$ezvizHealth=$null
try {$ezvizHealth=Invoke-RestMethod "$ezvizUrl/health" -TimeoutSec 2}catch{}
if($ezvizHealth){
 if($ezvizHealth.service -ne 'ezviz'){throw 'This port belongs to another service.'}
 if($ezvizHealth.closing){throw 'EZVIZ is still stopping media and cameras. Wait before starting again.'}
 Write-Host "EZVIZ: $ezvizUrl";exit 0
}
if(-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist-local\index.html'))){throw 'Build the local UI first: npm run build in apps/ezviz-console.'}
$nodePath=(Get-Command node -ErrorAction Stop).Source
$ezvizFfmpeg=Join-Path $ezvizRoot 'tools\node_modules\ffmpeg-static\ffmpeg.exe'
if($env:EZVIZ_FFMPEG){$ezvizFfmpeg=$env:EZVIZ_FFMPEG}
if(-not (Test-Path -LiteralPath $ezvizFfmpeg -PathType Leaf)){throw 'Local FFmpeg is missing. Restore tools\node_modules\ffmpeg-static\ffmpeg.exe.'}
New-Item -ItemType Directory -Path $localState -Force | Out-Null
$ezvizProcess=Start-Process -FilePath $nodePath -ArgumentList @("`"$serverPath`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localState 'ezviz-server.out.log') -RedirectStandardError (Join-Path $localState 'ezviz-server.err.log') -PassThru
Set-Content -LiteralPath (Join-Path $localState 'ezviz-server.pid') -Value $ezvizProcess.Id -Encoding ascii
for($attempt=0;$attempt -lt 50;$attempt++){
 Start-Sleep -Milliseconds 200
 try {$ezvizHealth=Invoke-RestMethod "$ezvizUrl/health" -TimeoutSec 1;if($ezvizHealth.service -eq 'ezviz'){Write-Host "EZVIZ: $ezvizUrl";exit 0}}catch{}
 if($ezvizProcess.HasExited){break}
}
throw 'EZVIZ failed to start. See .local/ezviz-server.err.log.'
