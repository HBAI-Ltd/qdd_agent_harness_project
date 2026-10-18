$ErrorActionPreference='Stop'
$haikRoot=$PSScriptRoot
$haikPort=8787
if($env:HAIK_PORT){$haikPort=[int]$env:HAIK_PORT}
if($haikPort -lt 1024 -or $haikPort -gt 65535){throw 'Invalid HAIK_PORT.'}
$haikUrl="http://127.0.0.1:$haikPort"
$projectRoot=Join-Path $haikRoot 'sites\haik-console'
$serverPath=Join-Path $projectRoot 'local\server.mjs'
$localState=Join-Path $haikRoot '.local'
$haikHealth=$null
try {$haikHealth=Invoke-RestMethod "$haikUrl/health" -TimeoutSec 2}catch{}
if($haikHealth){
 if($haikHealth.service -ne 'haik'){throw 'This port belongs to another service.'}
 if($haikHealth.closing){throw 'HAIK is still stopping media and cameras. Wait before starting again.'}
 Write-Host "HAIK: $haikUrl";exit 0
}
$nodePath=(Get-Command node -ErrorAction Stop).Source
if(-not (Test-Path -LiteralPath (Join-Path $localState 'haik-credentials.dpapi'))){throw 'Initialize your client configuration first: node scripts/initialize-haik.mjs'}
$haikFfmpeg=Join-Path $haikRoot 'tools\node_modules\ffmpeg-static\ffmpeg.exe'
if($env:HAIK_FFMPEG){$haikFfmpeg=$env:HAIK_FFMPEG}
if(-not (Test-Path -LiteralPath $haikFfmpeg -PathType Leaf)){throw 'Local FFmpeg is missing. Restore tools\node_modules\ffmpeg-static\ffmpeg.exe.'}
New-Item -ItemType Directory -Path $localState -Force | Out-Null
$haikProcess=Start-Process -FilePath $nodePath -ArgumentList @("`"$serverPath`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localState 'server.out.log') -RedirectStandardError (Join-Path $localState 'server.err.log') -PassThru
Set-Content -LiteralPath (Join-Path $localState 'server.pid') -Value $haikProcess.Id -Encoding ascii
for($attempt=0;$attempt -lt 50;$attempt++){
 Start-Sleep -Milliseconds 200
 try {$haikHealth=Invoke-RestMethod "$haikUrl/health" -TimeoutSec 1;if($haikHealth.service -eq 'haik'){Write-Host "HAIK: $haikUrl";exit 0}}catch{}
 if($haikProcess.HasExited){break}
}
throw 'HAIK failed to start. See .local/server.err.log.'
