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

    ssh <host> "powershell -File %USERPROFILE%\\mcp.andreglegg.no\\update.ps1"
