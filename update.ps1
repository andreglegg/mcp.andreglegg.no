# Pull, install, restart. Run on the box: powershell -File update.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

git pull --ff-only
npm ci --omit=dev

Stop-ScheduledTask  -TaskName 'mcp-host' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'mcp-host'

Start-Sleep -Seconds 3
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 5
Write-Host "mcp-host is $($health.status), routes: $($health.routes -join ', ')"
