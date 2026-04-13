$ErrorActionPreference = "Continue"
$workspace = "C:\wechat-codex-bridge"
$powershellExe = "$PSHOME\powershell.exe"
$codexbridgeSupervisor = Join-Path $workspace "scripts\supervise-codexbridge.ps1"
$cowagentSupervisor = Join-Path $workspace "scripts\supervise-cowagent.ps1"
function Test-CodexBridgeHealthy { try { (Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 5).status -eq "ok" } catch { $false } }
function Test-PortListening { param([int]$Port) [bool](netstat -ano -p tcp | Select-String "127.0.0.1:$Port|0.0.0.0:$Port") }
function Start-Supervisor { param([string]$ScriptPath) Start-Process -FilePath $powershellExe -ArgumentList @("-NoProfile","-WindowStyle","Hidden","-ExecutionPolicy","Bypass","-File",$ScriptPath) -WorkingDirectory $workspace -WindowStyle Hidden | Out-Null }
while ($true) {
  if (-not (Test-CodexBridgeHealthy)) { Start-Supervisor -ScriptPath $codexbridgeSupervisor; Start-Sleep -Seconds 8 }
  if (-not (Test-PortListening -Port 9899)) { Start-Supervisor -ScriptPath $cowagentSupervisor; Start-Sleep -Seconds 8 }
  Start-Sleep -Seconds 30
}