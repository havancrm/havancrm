# ART CRM: set up the sync server on Windows so it starts at sign-in and restarts if it stops.
# Run in PowerShell from the repository folder:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
# Requires Node.js 18+ and Tailscale (signed in, Funnel enabled in the admin console).

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Port = 8080
$DataDir = Join-Path $Repo 'data'
$TaskName = 'ART CRM Server'

# 1. Node.js check
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'ไม่พบ Node.js ติดตั้งจาก https://nodejs.org (เวอร์ชัน 18 ขึ้นไป) แล้วรันสคริปต์นี้ใหม่' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 18) { throw "Node.js ต้องเป็นเวอร์ชัน 18 ขึ้นไป (ตอนนี้ $(node -v))" }

# 2. Sync token: reuse the saved one, or create a new random one.
$existing = [Environment]::GetEnvironmentVariable('ARTCRM_SYNC_TOKEN', 'User')
if ($existing) {
  $token = $existing
  Write-Host 'ใช้รหัสซิงก์ที่บันทึกไว้เดิม'
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes)
  [Environment]::SetEnvironmentVariable('ARTCRM_SYNC_TOKEN', $token, 'User')
  Write-Host 'สร้างรหัสซิงก์ใหม่และบันทึกไว้ในบัญชีผู้ใช้ของ Windows แล้ว'
}
[Environment]::SetEnvironmentVariable('SYNC_TOKEN', $token, 'User')
[Environment]::SetEnvironmentVariable('PORT', "$Port", 'User')
[Environment]::SetEnvironmentVariable('DATA_DIR', $DataDir, 'User')
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# 3. Scheduled task: start at sign-in, restart up to 999 times if it stops.
$action = New-ScheduledTaskAction -Execute $node.Source -Argument 'server\server.js' -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "ตั้งงาน '$TaskName' แล้ว เซิร์ฟเวอร์เริ่มทำงานที่พอร์ต $Port"

# 4. Public HTTPS through Tailscale Funnel.
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
  Write-Warning 'ไม่พบคำสั่ง tailscale ติดตั้งจาก https://tailscale.com/download แล้วรันคำสั่งนี้:  tailscale funnel --bg 8080'
} else {
  tailscale funnel --bg $Port
  Write-Host 'เปิด Funnel แล้ว ดู URL ได้จาก: tailscale funnel status'
}

Write-Host ''
Write-Host "ตรวจสอบ: เปิด http://localhost:$Port/api/health ในเบราว์เซอร์ ต้องได้ {""ok"":true,...}"
Write-Host 'รหัสซิงก์อยู่ในตัวแปร ARTCRM_SYNC_TOKEN ของบัญชีผู้ใช้ ดูได้จาก Settings > Environment variables'
