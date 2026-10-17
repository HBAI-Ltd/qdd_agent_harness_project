$ErrorActionPreference = "Stop"
$idfArguments = @($args)
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-LocalSetting([string]$name) {
  if ($null -eq $localSettings) {
    return $null
  }
  $property = $localSettings.PSObject.Properties[$name]
  if ($null -eq $property -or [string]::IsNullOrWhiteSpace($property.Value)) {
    return $null
  }
  if ($property.Value -isnot [string]) {
    throw "Local setting '$name' must be a path string."
  }
  return $property.Value
}

function Resolve-LocalPath([string]$path) {
  if ([IO.Path]::IsPathRooted($path)) {
    return [IO.Path]::GetFullPath($path)
  }
  return [IO.Path]::GetFullPath((Join-Path $projectRoot $path))
}

function Get-GitBash {
  $configuredBash = Get-LocalSetting "bashPath"
  if ($configuredBash) {
    return Resolve-LocalPath $configuredBash
  }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) {
    $directory = Split-Path -Parent $git.Source
    for ($level = 0; $level -lt 3; $level++) {
      $candidate = Join-Path $directory "bin/bash.exe"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
      }
      $directory = Split-Path -Parent $directory
      if (-not $directory) {
        break
      }
    }
  }
  throw "Git Bash was not found. Set bashPath in apps/esp/.idf.local.json to Git's bin/bash.exe."
}

try {
  $localSettings = $null
  $settingsPath = Join-Path $projectRoot ".idf.local.json"
  if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $localSettings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  }

  $idfPath = $env:IDF_PATH
  if ([string]::IsNullOrWhiteSpace($idfPath)) {
    $idfPath = Get-LocalSetting "idfPath"
  }
  if ([string]::IsNullOrWhiteSpace($idfPath)) {
    throw "Set IDF_PATH or copy .idf.local.example.json to .idf.local.json and configure idfPath. ESP-IDF v5.5.3 is required."
  }
  $env:IDF_PATH = Resolve-LocalPath $idfPath
  $exportScript = Join-Path $env:IDF_PATH "export.ps1"
  $idfScript = Join-Path $env:IDF_PATH "tools/idf.py"
  if (-not (Test-Path -LiteralPath $exportScript -PathType Leaf) -or
      -not (Test-Path -LiteralPath $idfScript -PathType Leaf)) {
    throw "IDF_PATH does not contain an ESP-IDF checkout: $env:IDF_PATH"
  }

  $toolsPath = Get-LocalSetting "toolsPath"
  if ([string]::IsNullOrWhiteSpace($env:IDF_TOOLS_PATH) -and $toolsPath) {
    $env:IDF_TOOLS_PATH = Resolve-LocalPath $toolsPath
  }
  $bootstrapPython = Get-LocalSetting "pythonPath"
  if ($bootstrapPython) {
    $bootstrapPython = Resolve-LocalPath $bootstrapPython
    if (-not (Test-Path -LiteralPath $bootstrapPython -PathType Leaf)) {
      throw "Configured pythonPath does not exist: $bootstrapPython"
    }
    $env:PATH = (Split-Path -Parent $bootstrapPython) + [IO.Path]::PathSeparator + $env:PATH
  }

  # npm starts this script in a child PowerShell, so activation stays local.
  . $exportScript
  if ($env:IDF_PYTHON_ENV_PATH) {
    $python = Join-Path $env:IDF_PYTHON_ENV_PATH "Scripts/python.exe"
  } else {
    $python = (Get-Command python.exe -ErrorAction Stop).Source
  }
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "The activated ESP-IDF Python environment was not found: $python"
  }
  $versionOutput = @(& $python $idfScript --version)
  if ($LASTEXITCODE -ne 0) {
    throw "ESP-IDF version check failed (exit $LASTEXITCODE)."
  }
  $version = $versionOutput -join "`n"
  if ($version -notmatch "(?m)^ESP-IDF v5\.5\.3\s*$") {
    throw "Expected ESP-IDF v5.5.3; got: $version"
  }

  Set-Location -LiteralPath $projectRoot
  if ($idfArguments.Count -gt 0 -and $idfArguments[0] -eq "--check") {
    Write-Output $version
    Write-Output "IDF_PATH=$env:IDF_PATH"
    Write-Output "Python=$python"
    foreach ($tool in @("cmake", "ninja", "riscv32-esp-elf-gcc")) {
      $command = Get-Command $tool -ErrorAction Stop
      $output = @(& $command.Source --version)
      if ($LASTEXITCODE -ne 0) {
        throw "$tool failed its version check (exit $LASTEXITCODE)."
      }
      Write-Output ($output | Select-Object -First 1)
    }
    Write-Output "ESP-IDF environment: PASS"
    exit 0
  }

  if ($idfArguments.Count -gt 0 -and $idfArguments[0] -eq "--validate") {
    $bash = Get-GitBash
    if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) {
      throw "Configured bashPath does not exist: $bash"
    }
    $env:PYTHON = $python.Replace("\", "/")
    $ccPath = Get-LocalSetting "ccPath"
    if ([string]::IsNullOrWhiteSpace($env:CC) -and $ccPath) {
      $env:CC = (Resolve-LocalPath $ccPath).Replace("\", "/")
    }
    $gateArguments = @($idfArguments | Select-Object -Skip 1)
    & $bash --noprofile --norc "tools/validate.sh" @gateArguments
    $commandExit = $LASTEXITCODE
  } else {
    if ($idfArguments.Count -eq 0) {
      $idfArguments = @("--help")
    }
    # A Node argv bridge avoids Windows PowerShell 5.1 splitting -D values
    # containing spaces. Arguments stay data and never become shell commands.
    $env:QDD_ESP_IDF_PYTHON = $python
    $env:QDD_ESP_IDF_SCRIPT = $idfScript
    $env:QDD_ESP_IDF_ARGUMENTS = ConvertTo-Json -InputObject $idfArguments -Compress
    & node (Join-Path $PSScriptRoot "idf-run.mjs")
    $commandExit = $LASTEXITCODE
  }
  exit $commandExit
} catch {
  [Console]::Error.WriteLine("ESP-IDF: " + $_.Exception.Message)
  exit 1
}
