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

Environment: `PORT` (default 8787), `ARTIFACT_DIR`, `PUBLIC_BASE_URL`.

## Architecture

Design and rationale — including why Cloudflare Workers was rejected and why
binaries are never returned inline — live in
`docs/superpowers/specs/2026-08-03-mcp-subdomain-design.md`.

The host runs on a self-hosted Windows machine behind a free Cloudflare Tunnel,
so the public endpoint is only up when that machine is.

## Adding a tool

1. Write `src/tools/<name>/index.js` exporting `register<Name>Tools(server, { store })`.
2. Add it to the route's array in `src/registry.js`. That's the only file that changes.
3. Return `store.put(bytes, ext)`'s URL — never raw bytes.

## Deploying to a host machine

The scripts take paths as parameters and default to the current user's profile,
so nothing here is tied to a particular machine.

**First-time setup**, from the checkout directory:

    npm ci --omit=dev
    powershell -File install.ps1

`install.ps1` registers `mcp-host` as a Scheduled Task at boot. The Node path is
absolute inside it because the task runs as SYSTEM, whose PATH excludes the
Node install directory; a bare `node` there fails with `0x80070002` while the
task still reports Ready and nothing listens.

**The tunnel.** `cloudflared tunnel login` needs a browser and cannot be
scripted. It can run on any machine, with the resulting credentials JSON copied
to the host:

    cloudflared tunnel login                                    # writes cert.pem
    cloudflared tunnel create <tunnel-name>                     # writes <UUID>.json
    cloudflared tunnel route dns <tunnel-name> mcp.andreglegg.no

Then on the host machine, copy `<UUID>.json` into the cloudflared directory,
copy `tunnel/config.example.yml` to `config.yml` there and fill in the tunnel
UUID, and run:

    powershell -File install-tunnel.ps1

**Do not use `cloudflared service install`.** On Windows it registers the
service with no arguments and drops the `--config` flag, so the service runs as
LocalSystem, finds no config, and sits there connecting to nothing while
reporting RUNNING. Copying the config into the LocalSystem profile does not fix
it either. The scheduled task in `install-tunnel.ps1` pins the full command line
and works.

**Redeploying** after a push — run `update.ps1` on the host machine:

    powershell -File update.ps1
