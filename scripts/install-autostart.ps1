# 注册“当前用户登录时静默启动 trae-proxy”的计划任务。
$ErrorActionPreference = 'Stop'
$TaskName = 'trae-proxy-autostart'
$Vbs = Join-Path $PSScriptRoot 'start-silent.vbs'
$StartPs1 = Join-Path $PSScriptRoot 'start.ps1'

$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")',
  ('sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $StartPs1 + '""", 0, False')
)
Set-Content -Path $Vbs -Value ($vbsLines -join "`r`n") -Encoding ASCII

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $Vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "已注册开机自启任务：$TaskName"
Write-Host "立即在后台启动一次..."
& $StartPs1
