$workspace = "C:\wechat-codex-bridge"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$items = @(
  @{ Name = "codexbridge"; Port = 8080; RunValue = "WeChatCodexBridge"; Base = (Join-Path $workspace "codexbridge") },
  @{ Name = "cowagent"; Port = 9899; RunValue = "WeChatCowAgent"; Base = (Join-Path $workspace "chatgpt-on-wechat") }
)
foreach ($item in $items) {
  $runValue = Get-ItemProperty -Path $runKey -Name $item.RunValue -ErrorAction SilentlyContinue
  $autostart = if ($null -ne $runValue) { "Configured" } else { "Missing" }
  $supervisorPid = ""; $childPid = ""; $listening = [bool](netstat -ano -p tcp | Select-String ":$($item.Port)\s+.*LISTENING\s+")
  if (Test-Path (Join-Path $item.Base ".resident.supervisor.pid")) { $supervisorPid = (Get-Content -Raw (Join-Path $item.Base ".resident.supervisor.pid")).Trim() }
  if (Test-Path (Join-Path $item.Base ".resident.child.pid")) { $childPid = (Get-Content -Raw (Join-Path $item.Base ".resident.child.pid")).Trim() }
  [PSCustomObject]@{ service = $item.Name; autostart = $autostart; port = $item.Port; listening = $listening; supervisor_pid = $supervisorPid; child_pid = $childPid }
}