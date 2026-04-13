param([Parameter(Mandatory = $true)][string]$Id,[string]$Reason = "Rejected by owner")
$ErrorActionPreference = "Stop"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$script = "C:\wechat-codex-bridge\codexbridge\set-approval-status.js"
& $nodeExe $script reject $Id $Reason
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }