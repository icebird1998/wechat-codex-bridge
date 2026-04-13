param([Parameter(Mandatory = $true)][string]$Id)
$ErrorActionPreference = "Stop"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$script = "C:\wechat-codex-bridge\codexbridge\set-approval-status.js"
& $nodeExe $script approve $Id
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }