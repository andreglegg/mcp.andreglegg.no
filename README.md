# mcp.andreglegg.no

Remote MCP tool host. Serves my own tools over Streamable HTTP so any MCP
client can use them without a local install.

| Route | Auth | Tools |
|---|---|---|
| `/treegen` | none | `generate_tree`, `random_tree`, `list_presets` |
| `/assetcut` | Cloudflare Access service token | `ping` only — real tools pending |
| `/dl/<id>` | none | artifact downloads, 30 min TTL |

## Use it

    claude mcp add --transport http treegen https://mcp.andreglegg.no/treegen

Tools return a short-lived download URL rather than the file itself — a
detail-2 tree GLB is ~664 KB, which has no business inside a model's context
window.

## Run locally

    npm install
    npm test
    PUBLIC_BASE_URL=http://localhost:8787 npm start

## Architecture

Design and rationale — including why Cloudflare Workers was rejected and why
binaries are never returned inline — live in
`docs/superpowers/specs/2026-08-03-mcp-subdomain-design.md`.

Runs on an always-on Windows box behind a free Cloudflare Tunnel. **The public
endpoint is only up when that box is up.**

## Adding a tool

1. Write `src/tools/<name>/index.js` exporting `register<Name>Tools(server, { store })`.
2. Add it to the route's array in `src/registry.js`. That's the only file that changes.
3. Return `store.put(bytes, ext)`'s URL — never raw bytes.

## Deploy

Redeploy after a push:

    ssh <host> "powershell -File %USERPROFILE%\\mcp.andreglegg.no\\update.ps1"

First-time setup on a fresh box:

    git clone https://github.com/andreglegg/mcp.andreglegg.no.git %USERPROFILE%\mcp.andreglegg.no
    cd %USERPROFILE%\mcp.andreglegg.no
    npm ci --omit=dev
    powershell -File install.ps1

Then the tunnel. `cloudflared tunnel login` needs a browser and cannot be
scripted; it can be run on any machine, and the resulting credentials JSON
copied to the box:

    cloudflared tunnel login                                    # writes cert.pem
    cloudflared tunnel create mcp-andreglegg                     # writes <UUID>.json
    cloudflared tunnel route dns mcp-andreglegg mcp.andreglegg.no
    # copy <UUID>.json and tunnel/config.yml to %USERPROFILE%\.cloudflared\ on the box
    powershell -File install-tunnel.ps1

**Do not use `cloudflared service install`.** On Windows it registers the
service with no arguments (`Cloudflared service arguments: [cloudflared.exe]`)
and drops the `--config` flag, so the service runs as LocalSystem, finds no
config, and sits there connecting to nothing while reporting RUNNING. Copying
the config into the LocalSystem profile does not fix it either. The scheduled
task in `install-tunnel.ps1` pins the full command line and works.
