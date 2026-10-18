[CmdletBinding()]
param([string]$JavaHome = $env:JAVA_HOME)

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
if (-not (Test-Path -LiteralPath $javac -PathType Leaf) -or -not (Test-Path -LiteralPath $java -PathType Leaf)) { throw "JDK 17+ is required." }
$output = Join-Path $projectRoot "build/stream-tests/classes"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$sources = @((Join-Path $projectRoot "src/cn/qdd/screenbridge/FrameStore.java"), (Join-Path $projectRoot "src/cn/qdd/screenbridge/FrameServer.java"), (Join-Path $projectRoot "src/cn/qdd/screenbridge/FramePixels.java"), (Join-Path $projectRoot "src/cn/qdd/screenbridge/CaptureCadence.java"), (Join-Path $projectRoot "src/cn/qdd/screenbridge/SetupAddress.java"), (Join-Path $projectRoot "src/cn/qdd/screenbridge/BoardClient.java"))
$sources += @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "tests") -Recurse -Filter "*.java" -File | ForEach-Object { $_.FullName })
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/CaptureWifiLock.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/PreviewProfile.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/CaptureConsent.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/PointerCalibration.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/Utf8ImeProtocol.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/ClipboardTextSession.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/ImeTextSession.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/ImeSetupState.java"
$sources += Join-Path $projectRoot "src/cn/qdd/screenbridge/BoardBluetooth.java"
& $javac -encoding UTF-8 -d $output @sources
if ($LASTEXITCODE -ne 0) { throw "Stream test compilation failed." }
& $java "-Djava.awt.headless=true" -cp $output cn.qdd.screenbridge.StreamTransportTest
if ($LASTEXITCODE -ne 0) { throw "Stream socket regression failed." }
& $java -cp $output cn.qdd.screenbridge.FramePixelsTest
if ($LASTEXITCODE -ne 0) { throw "Frame pixel regression failed." }
& $java -cp $output cn.qdd.screenbridge.CaptureCadenceTest
if ($LASTEXITCODE -ne 0) { throw "Frame cadence regression failed." }
& $java -cp $output cn.qdd.screenbridge.CaptureWifiLockTest
if ($LASTEXITCODE -ne 0) { throw "Projection Wi-Fi lock regression failed." }
& $java -cp $output cn.qdd.screenbridge.ProjectionLifecycleTest
if ($LASTEXITCODE -ne 0) { throw "Projection lifecycle regression failed." }
& $java -cp $output cn.qdd.screenbridge.CaptureConsentTest
if ($LASTEXITCODE -ne 0) { throw "Capture authorization regression failed." }
& $java -cp $output cn.qdd.screenbridge.PreviewProfileTest
if ($LASTEXITCODE -ne 0) { throw "Preview profile regression failed." }
& $java -cp $output cn.qdd.screenbridge.SetupAddressTest
if ($LASTEXITCODE -ne 0) { throw "Board selection regression failed." }
& $java -cp $output cn.qdd.screenbridge.BoardClientTest
if ($LASTEXITCODE -ne 0) { throw "Board HTTP regression failed." }
& $java -cp $output cn.qdd.screenbridge.BoardBluetoothTest
if ($LASTEXITCODE -ne 0) { throw "Board BLE readiness regression failed." }
& $java -cp $output cn.qdd.screenbridge.PointerCalibrationTest
if ($LASTEXITCODE -ne 0) { throw "Pointer calibration regression failed." }
& $java -cp $output cn.qdd.screenbridge.Utf8ImeProtocolTest
if ($LASTEXITCODE -ne 0) { throw "UTF-8 IME protocol regression failed." }
& $java -cp $output cn.qdd.screenbridge.ClipboardTextSessionTest
if ($LASTEXITCODE -ne 0) { throw "Clipboard session regression failed." }
& $java -cp $output cn.qdd.screenbridge.ImeTextSessionTest
if ($LASTEXITCODE -ne 0) { throw "IME lifecycle and preparation regression failed." }
& $java -cp $output cn.qdd.screenbridge.ImeRegistrationTest $projectRoot
if ($LASTEXITCODE -ne 0) { throw "IME registration regression failed." }
& (Join-Path $PSScriptRoot "test-endpoint.ps1") -JavaHome $JavaHome
