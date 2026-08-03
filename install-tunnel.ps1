# Registers the Cloudflare Tunnel connector to start at boot.
#
# Deliberately a Scheduled Task rather than `cloudflared service install`:
# that installer registers the service with no arguments and silently drops
# --config, so the service runs as LocalSystem, finds no tunnel to run, and
# reports RUNNING while the hostname serves error 1033.
#
# Expects cert.pem, <UUID>.json and config.yml already present in the
# cloudflared directory (see README).

param(
    [string]$Cloudflared = (Join-Path $env:USERPROFILE 'cloudflared.exe'),
    [string]$Config      = (Join-Path $env:USERPROFILE '.cloudflared\config.yml'),
    [string]$Hostname    = 'mcp.andreglegg.no'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Cloudflared)) { throw "cloudflared.exe not found at $Cloudflared" }
if (-not (Test-Path $Config))      { throw "tunnel config not found at $Config" }

schtasks /Create /TN cloudflared-mcp /SC ONSTART /RL HIGHEST /F `
  /TR "`"$Cloudflared`" --config `"$Config`" --no-autoupdate tunnel run"
schtasks /Run /TN cloudflared-mcp

Start-Sleep -Seconds 12
try {
    $health = Invoke-RestMethod -Uri "https://$Hostname/healthz" -TimeoutSec 20
    Write-Host "public endpoint is $($health.status), routes: $($health.routes -join ', ')"
} catch {
    Write-Host "tunnel task started but the public endpoint is not answering yet: $($_.Exception.Message)"
}
