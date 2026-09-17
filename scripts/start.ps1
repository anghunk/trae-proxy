# 启动 trae-proxy（后台隐藏窗口），写入 pid 与日志。重复启动会被忽略。
param(
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'logs\proxy.pid'
$OutLog  = Join-Path $Root 'logs\proxy.out.log'
$ErrLog  = Join-Path $Root 'logs\proxy.err.log'

function Test-Running([int]$procId) {
  if ($procId -le 0) { return $false }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $cli = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
    return ($null -ne $p -and $cli -and $cli -like '*trae-proxy*serve.ts*')
  } catch { return $false }
}

if (Test-Path $PidFile) {
  $oldId = [int]((Get-Content $PidFile -Raw).Trim())
  if (Test-Running $oldId) {
    Write-Host "trae-proxy 已在运行 (PID $oldId)"
    exit 0
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if ($Foreground) {
  node (Join-Path $Root 'src\serve.ts')
  exit $LASTEXITCODE
}

$proc = Start-Process -FilePath 'node' `
  -ArgumentList @((Join-Path $Root 'src\serve.ts')) `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
Start-Sleep -Seconds 2

if (Test-Running $proc.Id) {
  Write-Host "trae-proxy 已后台启动 (PID $($proc.Id))"
  Write-Host "  cn(国内) http://127.0.0.1:39303"
  Write-Host "  ai(国际) http://127.0.0.1:39304"
} else {
  Write-Host "启动失败，请查看日志：$ErrLog"
  Get-Content $ErrLog -ErrorAction SilentlyContinue
  exit 1
}
