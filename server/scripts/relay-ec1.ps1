# Relay diario EC1 al Worker: levanta ml-service y server solo si están caídos.
# El tick() de arranque del server hace el sync ESPN + push a /ingest; este
# script solo garantiza que el stack corra y espera a que termine el primer tick.
# Uso: tarea programada diaria 06:05 + al iniciar sesión (ver README, Deploy).
param(
  [int]$MlPort = 8001,
  [int]$ServerPort = 4000,
  [int]$TimeoutSec = 420
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$logDir = Join-Path $env:LOCALAPPDATA "Temp\opencode"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-Port([int]$port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Detached([string]$workDir, [string]$command, [string]$logFile) {
  $escaped = $command -replace '"', '""'
  Invoke-WmiMethod -Class Win32_Process -Name Create `
    -ArgumentList "cmd /c cd /d `"$workDir`" && $escaped > `"$logFile`" 2>&1" | Out-Null
}

function Wait-Health([string]$url, [int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      if ((Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing).StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Seconds 5 }
  }
  return $false
}

if (-not (Test-Port $MlPort)) {
  Write-Output "[relay-ec1] ml-service caído: lanzando..."
  Start-Detached (Join-Path $repoRoot "ml-service") "python -m uvicorn app.api:app --port $MlPort" (Join-Path $logDir "ml-relay.log")
  if (-not (Wait-Health "http://127.0.0.1:$MlPort/health" 120)) {
    Write-Output "[relay-ec1] ERROR: ml-service no respondió"
    exit 1
  }
} else {
  Write-Output "[relay-ec1] ml-service ya corre"
}

if (-not (Test-Port $ServerPort)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmm"
  $serverLog = Join-Path $logDir "server-relay-$stamp.log"
  Write-Output "[relay-ec1] server caído: lanzando..."
  Start-Detached (Join-Path $repoRoot "server") "npm run start" $serverLog
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    if (Test-Path $serverLog -PathType Leaf) {
      $hit = Select-String -Path $serverLog -Pattern "\[relay\]|\[sync\] processed=" | Select-Object -Last 1
      if ($hit) { Write-Output "[relay-ec1] tick completo: $($hit.Line)"; exit 0 }
    }
  }
  Write-Output "[relay-ec1] ERROR: tick sin completar (ver $serverLog)"
  exit 1
} else {
  Write-Output "[relay-ec1] server ya corre (el cron de las 06:00 hace el relay)"
}
