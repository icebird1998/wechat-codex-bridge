$workspace = "C:\wechat-codex-bridge"
$items = @(@{ Base = (Join-Path $workspace "codexbridge") },@{ Base = (Join-Path $workspace "chatgpt-on-wechat") })
foreach ($item in $items) {
  $stopFile = Join-Path $item.Base ".resident.stop"
  New-Item -ItemType File -Force -Path $stopFile | Out-Null
  foreach ($pidFile in @((Join-Path $item.Base ".resident.child.pid"),(Join-Path $item.Base ".resident.supervisor.pid"))) {
    if (Test-Path $pidFile) {
      $pidValue = (Get-Content -Raw $pidFile).Trim()
      if ($pidValue) { Stop-Process -Id ([int]$pidValue) -Force -ErrorAction SilentlyContinue }
    }
  }
}