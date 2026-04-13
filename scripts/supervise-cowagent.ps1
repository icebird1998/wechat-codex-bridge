$ErrorActionPreference = "Stop"
$workspace = "C:\wechat-codex-bridge"
$runtimeBase = Join-Path $workspace "chatgpt-on-wechat"
$stopFile = Join-Path $runtimeBase ".resident.stop"
$supervisorPidFile = Join-Path $runtimeBase ".resident.supervisor.pid"
$childPidFile = Join-Path $runtimeBase ".resident.child.pid"
$supervisorLog = Join-Path $runtimeBase "cowagent-supervisor.log"
$runner = Join-Path $workspace "scripts\run-cowagent-no-proxy.bat"
$configPath = Join-Path $runtimeBase "config.json"
$configBackupPath = Join-Path $runtimeBase "config.runtime.backup.json"
$mutex = New-Object System.Threading.Mutex($false, "Local\WeChatCowAgentSupervisor")
if (-not $mutex.WaitOne(0, $false)) { exit 0 }
function Ensure-ValidConfig {
  if (-not (Test-Path $configPath)) { if (Test-Path $configBackupPath) { Copy-Item -LiteralPath $configBackupPath -Destination $configPath -Force }; return }
  try { $null = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { if (Test-Path $configBackupPath) { Copy-Item -LiteralPath $configBackupPath -Destination $configPath -Force } else { throw } }
}
try {
  Remove-Item $stopFile -ErrorAction SilentlyContinue
  Set-Content -Path $supervisorPidFile -Value $PID
  while ($true) {
    if (Test-Path $stopFile) { break }
    Ensure-ValidConfig
    $proc = Start-Process -FilePath $env:ComSpec -ArgumentList "/c", $runner -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
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