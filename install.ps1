# One-time setup on the box. Registers mcp-host to start at boot.
#
# The node path is absolute on purpose: the task runs as SYSTEM, whose PATH
# does not include C:\Program Files\nodejs, so a bare `node` fails with
# 0x80070002 (file not found) and the task reports Ready while nothing listens.
$ErrorActionPreference = 'Stop'

$node   = 'C:\Program Files\nodejs\node.exe'
$server = Join-Path $PSScriptRoot 'src\server.js'

if (-not (Test-Path $node))   { throw "node.exe not found at $node" }
if (-not (Test-Path $server)) { throw "server.js not found at $server" }

schtasks /Create /TN mcp-host /SC ONSTART /RL HIGHEST /F /TR "`"$node`" $server"
schtasks /Run /TN mcp-host

Start-Sleep -Seconds 4
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 5
Write-Host "mcp-host is $($health.status), routes: $($health.routes -join ', ')"
