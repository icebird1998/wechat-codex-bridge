$workspace = "C:\wechat-codex-bridge"
$powershellExe = "$PSHOME\powershell.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$definitions = @(
  @{ Name = "WeChatCodexBridge"; Script = (Join-Path $workspace "scripts\supervise-codexbridge.ps1") },
  @{ Name = "WeChatCowAgent"; Script = (Join-Path $workspace "scripts\supervise-cowagent.ps1") },
  @{ Name = "WeChatResidentWatchdog"; Script = (Join-Path $workspace "scripts\watch-resident-services.ps1") }
)
foreach ($definition in $definitions) {
  $command = "`"$powershellExe`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($definition.Script)`""
  New-ItemProperty -Path $runKey -Name $definition.Name -PropertyType String -Value $command -Force | Out-Null
}
Start-Process -FilePath $powershellExe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$(Join-Path $workspace 'scripts\start-resident-services.ps1')`"" -WorkingDirectory $workspace -WindowStyle Hidden | Out-Null