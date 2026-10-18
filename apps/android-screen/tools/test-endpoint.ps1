[CmdletBinding()]
param([string]$JavaHome = $env:JAVA_HOME, [string]$BaselineClasses = "")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchainFile = Join-Path $projectRoot ".local/toolchain.json"
if (-not $PSBoundParameters.ContainsKey("JavaHome") -and (Test-Path -LiteralPath $toolchainFile -PathType Leaf)) {
  $toolchain = Get-Content -LiteralPath $toolchainFile -Raw | ConvertFrom-Json
  if ($toolchain.PSObject.Properties.Name -contains "javaHome") { $JavaHome = [string]$toolchain.javaHome }
}
if ([string]::IsNullOrWhiteSpace($JavaHome)) { throw "Set JAVA_HOME to JDK 17+ or pass -JavaHome." }
$javac = Join-Path $JavaHome "bin/javac.exe"
$java = Join-Path $JavaHome "bin/java.exe"
$streamClasses = Join-Path $projectRoot "build/stream-tests/classes"
if (-not (Test-Path -LiteralPath (Join-Path $streamClasses "cn/qdd/screenbridge/FrameStore.class"))) { throw "Run test-stream.ps1 first to compile shared host dependencies." }
$output = Join-Path $projectRoot "build/endpoint-tests/classes"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$sources = @((Join-Path $projectRoot "src/cn/qdd/screenbridge/ScreenApplication.java"), (Join-Path $projectRoot "src/cn/qdd/screenbridge/FrameServer.java"))
$sources += @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "endpoint-tests/src") -Recurse -Filter "*.java" -File | ForEach-Object { $_.FullName })
& $javac -encoding UTF-8 -cp $streamClasses -d $output @sources
if ($LASTEXITCODE -ne 0) { throw "Endpoint recovery test compilation failed." }
$testClasspath = "$output;$streamClasses"
if (-not [string]::IsNullOrWhiteSpace($BaselineClasses)) { $testClasspath = "$BaselineClasses;$testClasspath" }
& $java -cp $testClasspath cn.qdd.screenbridge.EndpointRecoveryTest
if ($LASTEXITCODE -ne 0) { throw "Endpoint recovery regression failed." }
