[CmdletBinding()]
param(
  [string]$ScrcpyPath = $env:ANDROID_SCRCPY_PATH,
  [string]$AdbPath = $env:ANDROID_ADB_PATH,
  [string]$DeviceSerial = $env:ANDROID_DEVICE_SERIAL,
  [switch]$Check,
  [switch]$Wait
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Read-LocalConfiguration {
  $configuration = @{}
  $configurationPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
  if (Test-Path -LiteralPath $configurationPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $configurationPath) {
      if ($line -match '^\s*(ANDROID_SCRCPY_PATH|ANDROID_ADB_PATH|ANDROID_DEVICE_SERIAL)\s*=\s*(.*?)\s*$') {
        $configuration[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
      }
    }
  }
  return $configuration
}

function Resolve-Executable([string]$Configured, [string]$Command, [string[]]$Candidates = @()) {
  if (-not [string]::IsNullOrWhiteSpace($Configured)) {
    if (Test-Path -LiteralPath $Configured -PathType Leaf) {
      return (Resolve-Path -LiteralPath $Configured).Path
    }
    $explicitCommand = Get-Command -Name $Configured -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($explicitCommand) { return $explicitCommand.Source }
    throw "Configured executable does not exist: $Configured"
  }
  foreach ($candidate in $Candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  $found = Get-Command -Name $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Source }
  throw "Cannot find $Command. Configure its absolute path in apps/android-mcp/.env."
}

$localConfiguration = Read-LocalConfiguration
if ([string]::IsNullOrWhiteSpace($ScrcpyPath)) { $ScrcpyPath = $localConfiguration["ANDROID_SCRCPY_PATH"] }
if ([string]::IsNullOrWhiteSpace($AdbPath)) { $AdbPath = $localConfiguration["ANDROID_ADB_PATH"] }
if ([string]::IsNullOrWhiteSpace($DeviceSerial)) { $DeviceSerial = $localConfiguration["ANDROID_DEVICE_SERIAL"] }
if ([string]::IsNullOrWhiteSpace($DeviceSerial) -or $DeviceSerial -match '[\s\x00]' -or $DeviceSerial.StartsWith("-")) {
  throw "Choose the exact USB-connected Android serial with -DeviceSerial or ANDROID_DEVICE_SERIAL."
}

$sdkCandidates = @()
foreach ($sdkRoot in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)) {
  if (-not [string]::IsNullOrWhiteSpace($sdkRoot)) { $sdkCandidates += Join-Path $sdkRoot "platform-tools/adb.exe" }
}
$resolvedScrcpy = Resolve-Executable $ScrcpyPath "scrcpy.exe"
$resolvedAdb = Resolve-Executable $AdbPath "adb.exe" $sdkCandidates
$previewArguments = @("--serial=$DeviceSerial", "--no-control", "--no-audio", "--no-clipboard-autosync")

if ($Check) {
  & $resolvedScrcpy --version
  if ($LASTEXITCODE -ne 0) { throw "scrcpy version check failed." }
  Write-Output "ADB: $resolvedAdb"
  Write-Output "Read-only USB preview: $resolvedScrcpy $($previewArguments -join ' ')"
  exit 0
}

# Keep scrcpy and the MCP host on the same ADB executable; restore the caller's environment.
$previousAdb = [Environment]::GetEnvironmentVariable("ADB", "Process")
try {
  $env:ADB = $resolvedAdb
  $startOptions = @{
    FilePath = $resolvedScrcpy
    ArgumentList = $previewArguments
    WorkingDirectory = Split-Path -Parent $resolvedScrcpy
    PassThru = $true
    WindowStyle = "Normal"
  }
  if ($Wait) { $startOptions["Wait"] = $true }
  $preview = Start-Process @startOptions
  if ($Wait -and $preview.ExitCode -ne 0) { throw "scrcpy exited with code $($preview.ExitCode)." }
  Write-Output "Read-only Android preview process: $($preview.Id)"
} finally {
  [Environment]::SetEnvironmentVariable("ADB", $previousAdb, "Process")
}
