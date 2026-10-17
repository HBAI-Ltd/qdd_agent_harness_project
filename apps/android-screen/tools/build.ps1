[CmdletBinding()]
param(
  [string]$SdkRoot,
  [string]$JavaHome = $env:JAVA_HOME,
  [string]$CompileSdk = "34",
  [string]$BuildToolsVersion = "36.0.0",
  [int]$TargetSdk = 34
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot "build"
$localRoot = Join-Path $projectRoot ".local"
$toolchainFile = Join-Path $localRoot "toolchain.json"
if (Test-Path -LiteralPath $toolchainFile -PathType Leaf) {
  $toolchain = Get-Content -LiteralPath $toolchainFile -Raw | ConvertFrom-Json
  if (-not $PSBoundParameters.ContainsKey("SdkRoot") -and $toolchain.PSObject.Properties.Name -contains "sdkRoot") { $SdkRoot = [string]$toolchain.sdkRoot }
  if (-not $PSBoundParameters.ContainsKey("JavaHome") -and $toolchain.PSObject.Properties.Name -contains "javaHome") { $JavaHome = [string]$toolchain.javaHome }
}

function Require-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required tool/file missing: $Path" }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Build tool failed: $(Split-Path -Leaf $Executable) (exit $LASTEXITCODE)" }
}

if (-not [string]::IsNullOrWhiteSpace($SdkRoot)) {
  if (-not (Test-Path -LiteralPath $SdkRoot -PathType Container)) { throw "Configured Android SDK does not exist: $SdkRoot" }
} else {
  $sdkCandidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)
  if ($env:LOCALAPPDATA) { $sdkCandidates += Join-Path $env:LOCALAPPDATA "Android/Sdk" }
  $SdkRoot = $sdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ "platforms/android-$CompileSdk/android.jar") -PathType Leaf) } | Select-Object -First 1
  if (-not $SdkRoot) { throw "Set a valid ANDROID_HOME/ANDROID_SDK_ROOT or pass -SdkRoot with Android SDK Platform $CompileSdk." }
}
if ([string]::IsNullOrWhiteSpace($JavaHome)) { throw "Set JAVA_HOME to JDK 17+ or pass -JavaHome." }
if ($TargetSdk -lt 34) { throw "TargetSdk must be at least 34." }

$androidJar = Require-File (Join-Path $SdkRoot "platforms/android-$CompileSdk/android.jar")
$buildTools = Join-Path $SdkRoot "build-tools/$BuildToolsVersion"
$aapt = Require-File (Join-Path $buildTools "aapt2.exe")
$d8 = Require-File (Join-Path $buildTools "d8.bat")
$zipalign = Require-File (Join-Path $buildTools "zipalign.exe")
$signer = Require-File (Join-Path $buildTools "apksigner.bat")
$lambdaStubs = Require-File (Join-Path $buildTools "core-lambda-stubs.jar")
$javac = Require-File (Join-Path $JavaHome "bin/javac.exe")
$jar = Require-File (Join-Path $JavaHome "bin/jar.exe")
$keytool = Require-File (Join-Path $JavaHome "bin/keytool.exe")

foreach ($generatedName in @("generated", "classes", "dex")) {
  $generatedTarget = [IO.Path]::GetFullPath((Join-Path $buildRoot $generatedName))
  $buildBoundary = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $generatedTarget.StartsWith($buildBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw "Generated path escaped build directory." }
  if (Test-Path -LiteralPath $generatedTarget) { Remove-Item -LiteralPath $generatedTarget -Recurse -Force }
}
foreach ($directory in @($buildRoot, $localRoot, (Join-Path $buildRoot "generated"), (Join-Path $buildRoot "classes"), (Join-Path $buildRoot "dex"))) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$previousJava = [Environment]::GetEnvironmentVariable("JAVA_HOME", "Process")
try {
  $env:JAVA_HOME = $JavaHome
  Invoke-Checked $javac @("-version")
  Invoke-Checked $aapt @("compile", "--dir", (Join-Path $projectRoot "res"), "-o", (Join-Path $buildRoot "resources.zip"))
  Invoke-Checked $aapt @("link", "-o", (Join-Path $buildRoot "unsigned.apk"), "--manifest", (Join-Path $projectRoot "AndroidManifest.xml"),
    "-I", $androidJar, "--java", (Join-Path $buildRoot "generated"), "--min-sdk-version", "26", "--target-sdk-version", "$TargetSdk",
    "--version-code", "1", "--version-name", "0.1.0", (Join-Path $buildRoot "resources.zip"))
  $sources = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot "src"), (Join-Path $buildRoot "generated") -Recurse -Filter "*.java" -File | Sort-Object FullName | ForEach-Object { '"' + $_.FullName.Replace('\', '/') + '"' })
  $sourceList = Join-Path $buildRoot "sources.txt"
  [IO.File]::WriteAllLines($sourceList, $sources, [Text.UTF8Encoding]::new($false))
  # Android's own boot classpath prevents accidental linkage to desktop-only/newer JDK APIs.
  Invoke-Checked $javac @("-encoding", "UTF-8", "-source", "8", "-target", "8", "-bootclasspath", "$androidJar;$lambdaStubs", "-d", (Join-Path $buildRoot "classes"), "@$sourceList")
  $classesJar = Join-Path $buildRoot "classes.jar"
  Invoke-Checked $jar @("--create", "--file", $classesJar, "--date=2026-01-01T00:00:00Z", "-C", (Join-Path $buildRoot "classes"), ".")
  Invoke-Checked $d8 @("--lib", $androidJar, "--min-api", "26", "--output", (Join-Path $buildRoot "dex"), $classesJar)
  Invoke-Checked $jar @("--update", "--file", (Join-Path $buildRoot "unsigned.apk"), "--date=2026-01-01T00:00:00Z", "-C", (Join-Path $buildRoot "dex"), "classes.dex")
  Invoke-Checked $zipalign @("-f", "4", (Join-Path $buildRoot "unsigned.apk"), (Join-Path $buildRoot "aligned.apk"))
  $keystore = Join-Path $localRoot "debug.keystore"
  if (-not (Test-Path -LiteralPath $keystore -PathType Leaf)) {
    Invoke-Checked $keytool @("-genkeypair", "-keystore", $keystore, "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey",
      "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Android Debug,O=QDD,C=CN")
  }
  $apk = Join-Path $buildRoot "qdd-android-screen-debug.apk"
  Invoke-Checked $signer @("sign", "--ks", $keystore, "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", $apk, (Join-Path $buildRoot "aligned.apk"))
  Invoke-Checked $signer @("verify", "--verbose", $apk)
  Invoke-Checked $aapt @("dump", "badging", $apk)
  # Use .NET directly so hashing also works in Windows PowerShell 5.1 when
  # Microsoft.PowerShell.Utility command auto-loading is unavailable.
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $apkStream = $null
  try {
    $apkStream = [IO.File]::OpenRead($apk)
    $hash = [BitConverter]::ToString($sha256.ComputeHash($apkStream)).Replace("-", "").ToLowerInvariant()
  } finally {
    if ($null -ne $apkStream) { $apkStream.Dispose() }
    $sha256.Dispose()
  }
  [ordered]@{ apk = (Resolve-Path -LiteralPath $apk).Path; sha256 = $hash; applicationId = "cn.qdd.screenbridge";
    compileSdk = $CompileSdk; targetSdk = $TargetSdk; buildTools = $BuildToolsVersion; signing = "local development key" } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildRoot "manifest.json") -Encoding utf8
  Write-Output "APK: $apk"
  Write-Output "SHA256: $hash"
} finally {
  [Environment]::SetEnvironmentVariable("JAVA_HOME", $previousJava, "Process")
}
