param(
  [string]$SingBoxExe = "sing-box",
  [string]$ConfigPath = ".\\sing-box\\config.json",
  [string]$Proxy = "socks5://127.0.0.1:1080",
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

function Resolve-SingBoxExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Candidate
  )

  if (Test-Path -LiteralPath $Candidate) {
    $candidateItem = Get-Item -LiteralPath $Candidate -ErrorAction SilentlyContinue
    if ($null -ne $candidateItem) {
      if (-not $candidateItem.PSIsContainer) {
        return $candidateItem.FullName
      }

      $exeInDir = Join-Path $candidateItem.FullName "sing-box.exe"
      if (Test-Path -LiteralPath $exeInDir -PathType Leaf) {
        return (Resolve-Path -LiteralPath $exeInDir).Path
      }
    }
  }

  $namesToTry = @($Candidate)
  if (-not $Candidate.EndsWith(".exe")) {
    $namesToTry += "$Candidate.exe"
  }

  foreach ($name in $namesToTry) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $cmd -and $cmd.CommandType -eq "Application") {
      return $cmd.Source
    }
  }

  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetRoot) {
    $pkgDir = Get-ChildItem -LiteralPath $wingetRoot -Directory -Filter "SagerNet.sing-box_*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1

    if ($null -ne $pkgDir) {
      $exe = Get-ChildItem -LiteralPath $pkgDir.FullName -Recurse -File -Filter "sing-box.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($null -ne $exe) {
        return $exe.FullName
      }
    }
  }

  return $null
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Error "Config not found: $ConfigPath. Copy sing-box/config.template.json to sing-box/config.json and fill Mullvad values first."
}

$proxyUri = [Uri]$Proxy
$proxyHost = $proxyUri.Host
$proxyPort = $proxyUri.Port

Write-Host "Starting sing-box with config: $ConfigPath"
$resolvedSingBoxExe = Resolve-SingBoxExecutable -Candidate $SingBoxExe

if ([string]::IsNullOrWhiteSpace($resolvedSingBoxExe)) {
  throw (
    "sing-box executable not found. Install it with 'winget install SagerNet.sing-box' or pass -SingBoxExe <full-path-to-sing-box.exe>."
  )
}

Write-Host "Using sing-box executable: $resolvedSingBoxExe"

if (-not (Test-Path -LiteralPath $resolvedSingBoxExe -PathType Leaf)) {
  throw "Resolved sing-box path is not a file: $resolvedSingBoxExe"
}

$checkOutput = & $resolvedSingBoxExe check -c $ConfigPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "sing-box config check failed:`n$checkOutput"
}

$stdoutLogPath = Join-Path ([System.IO.Path]::GetTempPath()) "ytm-singbox-stdout.log"
$stderrLogPath = Join-Path ([System.IO.Path]::GetTempPath()) "ytm-singbox-stderr.log"

$singboxProcess = Start-Process -FilePath $resolvedSingBoxExe -ArgumentList @("run", "-c", $ConfigPath) -PassThru -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $proxyReady = $false

  while ((Get-Date) -lt $deadline) {
    if ($singboxProcess.HasExited) {
      $stdout = if (Test-Path -LiteralPath $stdoutLogPath) { Get-Content -LiteralPath $stdoutLogPath -Raw } else { "" }
      $stderr = if (Test-Path -LiteralPath $stderrLogPath) { Get-Content -LiteralPath $stderrLogPath -Raw } else { "" }
      throw "sing-box exited early with code $($singboxProcess.ExitCode).`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
    }

    try {
      $tcp = New-Object System.Net.Sockets.TcpClient
      $async = $tcp.BeginConnect($proxyHost, $proxyPort, $null, $null)
      if ($async.AsyncWaitHandle.WaitOne(500)) {
        $tcp.EndConnect($async)
        $proxyReady = $true
        $tcp.Close()
        break
      }
      $tcp.Close()
    } catch {
      # Retry until timeout.
    }

    Start-Sleep -Milliseconds 300
  }

  if (-not $proxyReady) {
    $stdout = if (Test-Path -LiteralPath $stdoutLogPath) { Get-Content -LiteralPath $stdoutLogPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrLogPath) { Get-Content -LiteralPath $stderrLogPath -Raw } else { "" }
    throw "Proxy endpoint $Proxy did not become ready within $TimeoutSeconds seconds.`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
  }

  Write-Host "Proxy is ready at $Proxy"

  $env:YTM_USE_PROXY = "true"
  $env:YTM_PROXY = $Proxy

  npm start
}
finally {
  if ($null -ne $singboxProcess -and -not $singboxProcess.HasExited) {
    Write-Host "Stopping sing-box (PID: $($singboxProcess.Id))"
    Stop-Process -Id $singboxProcess.Id -Force
  }
}
