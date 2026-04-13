$ErrorActionPreference = "Stop"
$workspace = "C:\wechat-codex-bridge"
$runtimeBase = Join-Path $workspace "codexbridge"
$workingDir = Join-Path $workspace "codexbridge"
$stopFile = Join-Path $runtimeBase ".resident.stop"
$supervisorPidFile = Join-Path $runtimeBase ".resident.supervisor.pid"
$childPidFile = Join-Path $runtimeBase ".resident.child.pid"
$supervisorLog = Join-Path $runtimeBase "codexbridge-supervisor.log"
$stdoutLog = Join-Path $runtimeBase "codexbridge.stdout.log"
$stderrLog = Join-Path $runtimeBase "codexbridge.stderr.log"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$serverScript = Join-Path $workingDir "server.js"
$mutex = New-Object System.Threading.Mutex($false, "Local\WeChatCodexBridgeSupervisor")
if (-not $mutex.WaitOne(0, $false)) { exit 0 }
function Write-Log { param([string]$m) Add-Content -Path $supervisorLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $m" }
try {
  Remove-Item $stopFile -ErrorAction SilentlyContinue
  Set-Content -Path $supervisorPidFile -Value $PID
  while ($true) {
    if (Test-Path $stopFile) { break }
    $proc = Start-Process -FilePath $nodeExe -ArgumentList $serverScript -WorkingDirectory $workingDir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    Set-Content -Path $childPidFile -Value $proc.Id
    Wait-Process -Id $proc.Id
    Remove-Item $childPidFile -ErrorAction SilentlyContinue
    if (Test-Path $stopFile) { break }
    Start-Sleep -Seconds 5
  }
} finally {
  Remove-Item $childPidFile,$supervisorPidFile,$stopFile -ErrorAction SilentlyContinue
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}