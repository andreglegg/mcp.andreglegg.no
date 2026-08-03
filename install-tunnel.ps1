# Registers the Cloudflare Tunnel connector to start at boot.
#
# Deliberately a Scheduled Task rather than `cloudflared service install`:
# that installer registers the service with no arguments and silently drops
# --config, so the service runs as LocalSystem, finds no tunnel to run, and
# reports RUNNING while the hostname serves error 1033.
#
# Expects cert.pem, <UUID>.json and config.yml already present in
# %USERPROFILE%\.cloudflared\ (see README).
$ErrorActionPreference = 'Stop'

$exe    = '%USERPROFILE%\cloudflared.exe'
$config = '%USERPROFILE%\.cloudflared\config.yml'

if (-not (Test-Path $exe))    { throw "cloudflared.exe not found at $exe" }
if (-not (Test-Path $config)) { throw "tunnel config not found at $config" }

schtasks /Create /TN cloudflared-mcp /SC ONSTART /RL HIGHEST /F `
  /TR "$exe --config $config --no-autoupdate tunnel run"
schtasks /Run /TN cloudflared-mcp

Start-Sleep -Seconds 12
try {
  $health = Invoke-RestMethod -Uri 'https://mcp.andreglegg.no/healthz' -TimeoutSec 20
  Write-Host "public endpoint is $($health.status), routes: $($health.routes -join ', ')"
} catch {
  Write-Host "tunnel task started but the public endpoint is not answering yet: $($_.Exception.Message)"
}
