# mcp.andreglegg.no — Remote MCP Tool Host

**Date:** 2026-08-03
**Status:** Approved, pending implementation plan

## Purpose

Host Andre's personal tools as remote MCP servers on a subdomain of `andreglegg.no`, so any
MCP client (Claude Code, Claude desktop, Codex) can reach them over HTTPS without a local
install. First tool is `treegen`; `assetcut` follows. The host is designed so adding tool #3
is cheap.

## Existing context

The rest of `andreglegg.no` is static hosting and **this project cannot reuse that path**:

| Fact | Value |
|---|---|
| DNS | Cloudflare (`ligia`/`ignat.ns.cloudflare.com`) |
| Root + `www` | GitHub Pages (`185.199.108-111.153`) |
| Existing subdomain pattern | One repo per subdomain, `CNAME` file, `.github/workflows/pages.yml`, push to `master` |
| Existing repos | `andreglegg/andreglegg.no` (Vite/TS), `andreglegg/endlessdescent.andreglegg.no` (plain static) |

GitHub Pages serves static files. A remote MCP server needs a live HTTP endpoint with POST
and SSE. Pages cannot do it, so this subdomain needs real compute.

### Available hardware

An always-on Windows box on the LAN, reachable at `<user>@<host>`:

- Windows 10.0.26200.8875
- Python 3.11.9
- Ollama running as a service
- `%USERPROFILE%\cloudflared.exe` — **already downloaded, never logged in, zero tunnels configured**

### Why not Cloudflare Workers

Workers' free tier caps CPU at 10 ms per request. Measured cost of a single treegen call on
an M-series Mac (Worker CPUs are slower):

| detail | generate | GLB export | triangles | output |
|---|---|---|---|---|
| 0 | 7.1 ms | 6.1 ms | 992 | 137 KB |
| 1 | 4.6 ms | 5.5 ms | 3136 | 327 KB |
| 2 | 5.1 ms | 5.0 ms | 6744 | 664 KB |

Every configuration exceeds the budget before accounting for slower hardware. Separately,
`assetcut` is Python with OpenCV, Pillow, numpy and optional ONNX models — it cannot run on
Workers at all. Both halves therefore run on the box, which collapses the design to one
runtime and one deploy.

## Cost and exposure

Public access is free via Cloudflare Tunnel; no money is spent. The real cost is **exposure**,
and it differs sharply per tool:

- `treegen` takes no file input and every parameter is bounded by its existing zod schema
  (`seed` 1–999999, `detail` 0–2, `leafDensity` 8–64). Worst-case compute per call is capped
  at ~13 ms. Safe to expose unauthenticated.
- `assetcut` consumes arbitrary uploaded images through OpenCV on a home network. Not safe to
  expose. Stays private.

**Accepted tradeoff:** the public endpoint is only up when the box is up. No zero-cost cloud
fallback exists. A reboot or home-connection drop takes `mcp.andreglegg.no` offline until it
returns.

## Architecture

```
public client   ──HTTPS──▶ Cloudflare edge ─┐
                                            ├─Tunnel──▶ box:8787  (Node, mcp-host)
you             ──HTTPS──▶ CF Access gate ──┘                    ├─ /treegen   open
                           (service token)                       ├─ /assetcut  gated
                                                                 └─ /dl/<id>   artifacts
```

This is the target topology. In v1 the `/assetcut` route and its Access application are
**configured but serve no tools** — the auth split is built and verified now so that landing
assetcut later is a registry entry, not an infrastructure change.

### Auth

`mcp.andreglegg.no/assetcut/*` is a Cloudflare Access application using a **service token**
(`CF-Access-Client-Id` / `CF-Access-Client-Secret` request headers), not browser SSO — an MCP
client cannot complete an interactive login. Claude Code's MCP config supports custom headers.
Rejection happens at Cloudflare's edge, so unauthorized traffic never reaches the house.

Documented fallback if Zero Trust configuration proves awkward: a bearer token checked in Node.
Simpler, but requests then reach the box before being refused.

### Transport

Streamable HTTP via `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`, in
stateless mode (`sessionIdGenerator: undefined`). No tool holds cross-call state, so sessions
add reconnect complexity for no benefit.

### Artifact I/O contract

This is the core design decision and the bulk of the work.

The local treegen server does `fs.writeFile(target)` and returns `{path}`. A filesystem path is
meaningless to a remote caller. Inlining a GLB as base64 is worse — a detail-2 tree is 664 KB,
roughly 885 KB once base64-encoded, which would flood the model's context window.

Instead:

> A tool writes its artifact to a temp directory and returns
> `{ url, species, seed, triangles, sizeKB }`. The URL is
> `https://mcp.andreglegg.no/dl/<random-id>.glb`, served by the same process, TTL 30 minutes,
> then swept.

Small text result, real bytes behind a link. **Every future tool that emits a binary uses this
same contract.** That is what makes adding the next tool cheap.

### Abuse controls on the public path

- Cloudflare's one free rate-limiting rule, applied to the hostname
- Existing zod parameter bounds (already present upstream, no change needed)
- Cap on total temp-directory size, independent of the per-artifact TTL

## Repository

New repo `andreglegg/mcp.andreglegg.no` at `~/WebstormProjects/mcp.andreglegg.no`, matching the
existing per-subdomain convention.

```
src/server.js          http + transport wiring
src/registry.js        tool registration — one import per tool
src/artifacts.js       temp store, URL minting, TTL sweep
src/tools/treegen/     generator.js, export.js (vendored)
tunnel/config.yml      cloudflared ingress
docs/superpowers/specs/
```

Each unit has one job: `server.js` owns HTTP and transport and knows nothing about specific
tools; `registry.js` is the only file that changes when a tool is added; `artifacts.js` is the
sole owner of temp files and URLs and is independently testable.

### Vendoring decision

`generator.js` and `export.js` are copied from `~/Apps/treegen/mcp/` into `src/tools/treegen/`
(256 lines total, stable). A `SOURCE.md` in that directory records upstream and the copy date.

Rejected alternative: push `treegen` to GitHub and consume it as a git dependency. Cleaner
provenance, but it requires publishing a repo that does not exist yet and adds a release step
to every generator change.

**Known cost of this choice:** the copy will drift from upstream. `SOURCE.md` makes the drift
visible; it does not prevent it.

## Deployment

Not GitHub Pages, and not a Pages-style workflow.

GitHub is the source of truth. The box pulls:

- `update.ps1` on the box runs `git pull && npm ci`, then stops and restarts the Node task
- Invoked over SSH — no self-hosted runner, no secrets on the box beyond the tunnel credential
- `cloudflared` installs as a native Windows service (survives reboot on its own)
- Node runs as a Scheduled Task triggered at startup, so a reboot self-heals

The two run under different Windows mechanisms because `cloudflared` ships native service
installation and Node does not; adding a supervisor such as NSSM or pm2 to unify them buys
nothing at this scale.

## Error handling

| Condition | Behavior |
|---|---|
| Invalid tool params | zod rejection surfaced as an MCP error result |
| Box or tunnel down | Cloudflare 1033. Unavoidable at zero cost; documented, not handled |
| Expired artifact URL | HTTP 410 with a "regenerate it" message, not a bare 404 |
| Unauthorized `/assetcut` | Refused at Cloudflare's edge before reaching the box |

## Testing

1. **Unit** — parameter validation rejects out-of-range input; artifact TTL sweep removes
   expired entries and leaves live ones.
2. **Integration** — boot the host, connect a real MCP SDK client over Streamable HTTP, call
   `list_tools` then generate, assert the returned download URL serves bytes beginning with the
   `glTF` magic number.
3. **End-to-end** — point Claude Code at the live URL and generate a tree.

## Scope

**In scope for v1:** the host (transport, auth split, tool registry, artifact contract),
`treegen` as the first tool, tunnel and service setup, DNS record.

**Explicitly deferred:** `assetcut` (lands second, and proves the registry claim), OAuth 2.1 /
dynamic client registration for third-party public use, any cloud fallback for box downtime.
