# 停止后台运行的 trae-proxy。
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'logs\proxy.pid'

$targets = @()
if (Test-Path $PidFile) {
  $targets += [int]((Get-Content $PidFile -Raw).Trim())
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*trae-proxy*serve.ts*' } |
  ForEach-Object { $targets += [int]$_.ProcessId }

$targets = $targets | Sort-Object -Unique
foreach ($id in $targets) {
  try {
    Stop-Process -Id $id -Force -ErrorAction Stop
    Write-Host "已停止 PID $id"
  } catch { }
}

if ($targets.Count -eq 0) { Write-Host 'trae-proxy 未在运行' }
