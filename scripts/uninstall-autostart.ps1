# 卸载开机自启任务（不影响正在运行的代理；如需停止请再运行 stop.ps1）。
$ErrorActionPreference = 'Continue'
$TaskName = 'trae-proxy-autostart'
$Vbs = Join-Path $PSScriptRoot 'start-silent.vbs'

try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Host "已删除计划任务：$TaskName"
} catch {
  Write-Host "计划任务不存在或已删除：$TaskName"
}
Remove-Item $Vbs -Force -ErrorAction SilentlyContinue
