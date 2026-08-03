# mcp.andreglegg.no Tool Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `mcp.andreglegg.no` as a remote MCP tool host serving `treegen` publicly over Streamable HTTP, with a gated `/assetcut` route reserved for later.

**Architecture:** One Node process on the always-on Windows box, exposed by a free Cloudflare Tunnel. Express routes `/treegen` (open) and `/assetcut` (Cloudflare Access, no tools in v1) to per-request stateless MCP transports. Binary outputs never travel inline — tools write to an artifact store and return a short-lived `/dl/<id>` URL plus small metadata.

**Tech Stack:** Node 24, `@modelcontextprotocol/sdk` 1.29.0, Express 5, `three` 0.168, `zod`, `node:test`, `cloudflared`.

## Global Constraints

- Node `>=24` — the box runs v24.18.1; ESM only (`"type": "module"`).
- `@modelcontextprotocol/sdk` pinned to `^1.29.0`; use `registerTool`, never the deprecated `server.tool`.
- Transports are **stateless**: `sessionIdGenerator: undefined`, one fresh `McpServer` + transport per HTTP request.
- No binary payload is ever returned in an MCP tool result. Artifacts go to the store; results carry a URL.
- Artifact TTL is 30 minutes. Total artifact directory cap is 512 MB.
- The public `/treegen` route takes no file input and no free-text paths. `outPath` from the local server is **removed**, not forwarded.
- Vendored treegen sources are copied, not edited — fixes go upstream to `~/Apps/treegen/mcp/` first.
- Tests run with `node --test`; no external test framework.

---

### Task 1: Artifact store

**Files:**
- Create: `package.json`
- Create: `src/artifacts.js`
- Create: `.gitignore` (already exists — verify `tmp/` and `node_modules/` are listed)
- Test: `test/artifacts.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `createArtifactStore({ dir, baseUrl, ttlMs?, maxTotalBytes?, maxEntries?, now? })` → store
  - `store.put(bytes: Buffer, ext: string)` → `{ id, url, sizeBytes, expiresAt }`
  - `store.get(id: string)` → `{ status: 'ok', path, contentType } | { status: 'expired' } | { status: 'missing' }`
  - `store.sweep()` → `number` (files deleted)
  - `store.totalBytes()` → `number`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mcp-andreglegg-no",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "express": "^5.1.0",
    "three": "^0.168.0",
    "zod": "^3.25.76"
  }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `test/artifacts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArtifactStore } from '../src/artifacts.js';

async function freshStore(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'artifacts-test-'));
  let clock = 1_000_000;
  const store = createArtifactStore({
    dir,
    baseUrl: 'https://mcp.example.no',
    ttlMs: 1000,
    now: () => clock,
    ...overrides,
  });
  return { store, dir, tick: (ms) => { clock += ms; } };
}

test('put stores bytes and mints a url under baseUrl', async () => {
  const { store } = await freshStore();
  const entry = await store.put(Buffer.from('glTF-ish'), 'glb');

  assert.match(entry.url, /^https:\/\/mcp\.example\.no\/dl\/[a-f0-9]{32}\.glb$/);
  assert.equal(entry.sizeBytes, 8);

  const got = store.get(entry.id);
  assert.equal(got.status, 'ok');
  assert.equal(got.contentType, 'model/gltf-binary');
  assert.equal(await readFile(got.path, 'utf8'), 'glTF-ish');
});

test('ids are unguessable and unique across puts', async () => {
  const { store } = await freshStore();
  const a = await store.put(Buffer.from('a'), 'glb');
  const b = await store.put(Buffer.from('b'), 'glb');
  assert.notEqual(a.id, b.id);
  assert.equal(a.id.length, 32);
});

test('get reports expired after the ttl, distinct from missing', async () => {
  const { store, tick } = await freshStore();
  const entry = await store.put(Buffer.from('x'), 'glb');

  assert.equal(store.get(entry.id).status, 'ok');
  tick(1001);
  assert.equal(store.get(entry.id).status, 'expired');
  assert.equal(store.get('0'.repeat(32)).status, 'missing');
});

test('get rejects path traversal attempts as missing', async () => {
  const { store } = await freshStore();
  assert.equal(store.get('../../etc/passwd').status, 'missing');
  assert.equal(store.get('a/b').status, 'missing');
});

test('sweep deletes expired files but keeps the tombstone', async () => {
  const { store, tick } = await freshStore();
  const live = await store.put(Buffer.from('live'), 'glb');
  const dead = await store.put(Buffer.from('dead'), 'glb');
  const deadPath = store.get(dead.id).path;

  tick(1001);
  await store.put(Buffer.from('fresh'), 'glb');

  const removed = await store.sweep();
  assert.equal(removed, 2);
  assert.equal(store.get(dead.id).status, 'expired');
  assert.equal(store.get(live.id).status, 'expired');
  await assert.rejects(readFile(deadPath));
});

test('put evicts oldest entries when over the byte cap', async () => {
  const { store } = await freshStore({ maxTotalBytes: 10 });
  const first = await store.put(Buffer.alloc(6), 'glb');
  await store.put(Buffer.alloc(6), 'glb');

  assert.equal(store.get(first.id).status, 'expired');
  assert.ok(store.totalBytes() <= 10);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/artifacts.test.js`
Expected: FAIL — `Cannot find module '../src/artifacts.js'`

- [ ] **Step 4: Implement the artifact store**

Create `src/artifacts.js`:

```js
// Short-lived store for tool output binaries. Tools never return bytes inline —
// they put them here and hand back the minted URL.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = {
  glb: 'model/gltf-binary',
  obj: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
};

const ID_PATTERN = /^[a-f0-9]{32}$/;

export function createArtifactStore({
  dir,
  baseUrl,
  ttlMs = 30 * 60 * 1000,
  maxTotalBytes = 512 * 1024 * 1024,
  maxEntries = 10_000,
  now = () => Date.now(),
}) {
  // id -> { ext, sizeBytes, expiresAt, deleted }. Entries outlive their files so
  // an expired URL can answer 410 instead of a bare 404.
  const entries = new Map();
  let ready = null;

  const fileFor = (id, ext) => path.join(dir, `${id}.${ext}`);

  function totalBytes() {
    let sum = 0;
    for (const e of entries.values()) if (!e.deleted) sum += e.sizeBytes;
    return sum;
  }

  async function drop(id, entry) {
    if (entry.deleted) return false;
    entry.deleted = true;
    await rm(fileFor(id, entry.ext), { force: true });
    return true;
  }

  async function evictUntilUnder(limit) {
    // Map preserves insertion order, so iterating gives oldest-first.
    for (const [id, entry] of entries) {
      if (totalBytes() <= limit) break;
      await drop(id, entry);
    }
  }

  function pruneTombstones() {
    if (entries.size <= maxEntries) return;
    const excess = entries.size - maxEntries;
    let i = 0;
    for (const [id, entry] of entries) {
      if (i++ >= excess) break;
      if (entry.deleted) entries.delete(id);
    }
  }

  return {
    async put(bytes, ext) {
      ready ??= mkdir(dir, { recursive: true });
      await ready;

      const id = randomBytes(16).toString('hex');
      const entry = { ext, sizeBytes: bytes.length, expiresAt: now() + ttlMs, deleted: false };
      await writeFile(fileFor(id, ext), bytes);
      entries.set(id, entry);

      await evictUntilUnder(maxTotalBytes);
      pruneTombstones();

      return { id, url: `${baseUrl}/dl/${id}.${ext}`, sizeBytes: entry.sizeBytes, expiresAt: entry.expiresAt };
    },

    get(id) {
      if (!ID_PATTERN.test(id)) return { status: 'missing' };
      const entry = entries.get(id);
      if (!entry) return { status: 'missing' };
      if (entry.deleted || now() >= entry.expiresAt) return { status: 'expired' };
      return {
        status: 'ok',
        path: fileFor(id, entry.ext),
        contentType: CONTENT_TYPES[entry.ext] ?? 'application/octet-stream',
      };
    },

    async sweep() {
      let removed = 0;
      const cutoff = now();
      for (const [id, entry] of entries) {
        if (!entry.deleted && cutoff >= entry.expiresAt && (await drop(id, entry))) removed += 1;
      }
      pruneTombstones();
      return removed;
    },

    totalBytes,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/artifacts.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/artifacts.js test/artifacts.test.js .gitignore
git commit -m "feat: add TTL-bounded artifact store with URL minting"
```

---

### Task 2: Vendor treegen and expose it as remote tools

**Files:**
- Create: `src/tools/treegen/generator.js` (copied verbatim from `~/Apps/treegen/mcp/generator.js`)
- Create: `src/tools/treegen/export.js` (copied verbatim from `~/Apps/treegen/mcp/export.js`)
- Create: `src/tools/treegen/SOURCE.md`
- Create: `src/tools/treegen/index.js`
- Test: `test/treegen.test.js`

**Interfaces:**
- Consumes: `createArtifactStore` from Task 1 (`store.put(bytes, ext)` → `{ url, sizeBytes, expiresAt }`)
- Produces: `registerTreegenTools(server, { store })` — registers `generate_tree`, `random_tree`, `list_presets` on an `McpServer`

- [ ] **Step 1: Copy the vendored sources**

```bash
mkdir -p src/tools/treegen
cp ~/Apps/treegen/mcp/generator.js src/tools/treegen/generator.js
cp ~/Apps/treegen/mcp/export.js src/tools/treegen/export.js
```

Create `src/tools/treegen/SOURCE.md`:

```markdown
# Vendored from treegen

`generator.js` and `export.js` are copied verbatim from `~/Apps/treegen/mcp/`
as of 2026-08-03.

**Do not edit them here.** Fix upstream first, then re-copy:

    cp ~/Apps/treegen/mcp/generator.js src/tools/treegen/generator.js
    cp ~/Apps/treegen/mcp/export.js    src/tools/treegen/export.js

`index.js` is *not* vendored — it is the remote-specific tool layer and has no
upstream counterpart. The local server at `~/Apps/treegen/mcp/server.js` writes
files to disk; this one writes to the artifact store instead.
```

- [ ] **Step 2: Write the failing test**

Create `test/treegen.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createArtifactStore } from '../src/artifacts.js';
import { registerTreegenTools } from '../src/tools/treegen/index.js';

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'treegen-test-'));
  const store = createArtifactStore({ dir, baseUrl: 'https://mcp.example.no' });
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const tools = registerTreegenTools(server, { store });
  return { store, tools };
}

// registerTreegenTools returns the raw handlers so tools can be tested without
// standing up a transport.
test('generate_tree returns a url and stats, never a filesystem path', async () => {
  const { tools } = await harness();
  const result = await tools.generate_tree({ species: 'oak', seed: 42, detail: 0 });
  const payload = JSON.parse(result.content[0].text);

  assert.match(payload.url, /^https:\/\/mcp\.example\.no\/dl\/[a-f0-9]{32}\.glb$/);
  assert.equal(payload.species, 'oak');
  assert.equal(payload.seed, 42);
  assert.ok(payload.triangles > 0);
  assert.ok(payload.sizeKB > 0);
  assert.equal(payload.path, undefined);
});

test('generated glb is a real glTF binary', async () => {
  const { store, tools } = await harness();
  const result = await tools.generate_tree({ species: 'pine', seed: 7, detail: 0 });
  const { url } = JSON.parse(result.content[0].text);
  const id = url.split('/dl/')[1].replace('.glb', '');

  const bytes = await readFile(store.get(id).path);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF');
});

test('same seed reproduces identical triangle counts', async () => {
  const { tools } = await harness();
  const a = JSON.parse((await tools.generate_tree({ seed: 99, species: 'oak' })).content[0].text);
  const b = JSON.parse((await tools.generate_tree({ seed: 99, species: 'oak' })).content[0].text);
  assert.equal(a.triangles, b.triangles);
});

test('obj and json formats are supported', async () => {
  const { tools } = await harness();
  const obj = JSON.parse((await tools.generate_tree({ seed: 5, format: 'obj' })).content[0].text);
  assert.match(obj.url, /\.obj$/);
  const json = JSON.parse((await tools.generate_tree({ seed: 5, format: 'json' })).content[0].text);
  assert.match(json.url, /\.json$/);
});

test('outPath is rejected — remote callers cannot write to the host filesystem', async () => {
  const { tools } = await harness();
  await assert.rejects(
    () => tools.generate_tree({ seed: 1, outPath: 'C:\\Windows\\evil.glb' }),
    /outPath/i
  );
});

test('random_tree rolls params and returns them alongside the url', async () => {
  const { tools } = await harness();
  const payload = JSON.parse((await tools.random_tree({ rollSeed: 123 })).content[0].text);
  assert.match(payload.url, /\.glb$/);
  assert.ok(payload.rolledParams.seed > 0);

  const again = JSON.parse((await tools.random_tree({ rollSeed: 123 })).content[0].text);
  assert.deepEqual(again.rolledParams, payload.rolledParams);
});

test('list_presets returns the built-in presets', async () => {
  const { tools } = await harness();
  const payload = JSON.parse((await tools.list_presets({})).content[0].text);
  assert.deepEqual(Object.keys(payload).sort(), ['acacia', 'meadow', 'oak', 'orchard', 'pine', 'willow']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/treegen.test.js`
Expected: FAIL — `Cannot find module '../src/tools/treegen/index.js'`

- [ ] **Step 4: Implement the remote tool layer**

Create `src/tools/treegen/index.js`:

```js
// Remote-facing treegen tools. The local server (~/Apps/treegen/mcp/server.js)
// writes GLB files to disk and returns paths; a path means nothing to a remote
// caller, and a 664KB GLB inlined as base64 would flood the model's context.
// So every artifact goes to the store and the caller gets a short-lived URL.
import { z } from 'zod';
import { buildTree, meshStats, presets, randomParams } from './generator.js';
import { exportGlb, exportObj } from './export.js';

const SPECIES = ['round', 'oak', 'acacia', 'willow', 'pine'];
const LEAF_STYLES = ['clustered', 'angular', 'rounded', 'flat', 'needles'];
const FORMATS = ['glb', 'obj', 'json'];

const paramShape = {
  species: z.enum(SPECIES).optional().describe('Tree species / silhouette'),
  seed: z.number().int().min(1).max(999999).optional().describe('Deterministic seed — same seed reproduces the same tree'),
  height: z.number().min(3).max(10).optional(),
  trunkRadius: z.number().min(0.18).max(0.9).optional(),
  branchCount: z.number().int().min(4).max(18).optional(),
  branchSpread: z.number().min(0.45).max(2.2).optional(),
  canopySize: z.number().min(0.9).max(3.6).optional(),
  leafDensity: z.number().int().min(8).max(64).optional().describe('Number of foliage clusters'),
  leafShape: z.number().min(0.15).max(1).optional().describe('Leaf roundness'),
  leafStyle: z.enum(LEAF_STYLES).optional(),
  leafSize: z.number().min(0.45).max(1.7).optional(),
  leafVariation: z.number().min(0).max(1).optional(),
  detail: z.number().int().min(0).max(2).optional().describe('0 low-poly, 1 game-ready, 2 hero'),
  lean: z.number().min(0).max(0.55).optional(),
  leafPalette: z.number().int().min(0).max(7).optional(),
  barkPalette: z.number().int().min(0).max(5).optional(),
};

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function serialize(group, format) {
  if (format === 'glb') return await exportGlb(group);
  if (format === 'obj') return Buffer.from(exportObj(group), 'utf8');
  return null; // json is handled by the caller — it serializes params, not geometry
}

export function registerTreegenTools(server, { store }) {
  async function build(params, format = 'glb') {
    const settings = { ...presets.meadow, ...params };
    const group = buildTree(params);
    const stats = meshStats(group);

    const bytes = format === 'json'
      ? Buffer.from(JSON.stringify(settings, null, 2), 'utf8')
      : await serialize(group, format);

    const artifact = await store.put(bytes, format);
    return {
      url: artifact.url,
      expiresAt: new Date(artifact.expiresAt).toISOString(),
      format,
      species: settings.species,
      seed: settings.seed,
      meshes: stats.meshes,
      triangles: stats.triangles,
      sizeKB: Math.round(artifact.sizeBytes / 102.4) / 10,
    };
  }

  function rejectOutPath(args) {
    if (args.outPath !== undefined) {
      throw new Error('outPath is not supported on the remote server — the generated file is returned as a download URL.');
    }
  }

  const handlers = {
    async generate_tree({ preset, format = 'glb', ...params }) {
      rejectOutPath(params);
      delete params.outPath;
      const base = preset ? presets[preset] : {};
      return ok(await build({ ...base, ...params }, format));
    },

    async random_tree({ species, rollSeed, format = 'glb', ...rest }) {
      rejectOutPath(rest);
      const roll = randomParams(rollSeed ?? 1);
      const params = { ...presets.meadow, ...roll };
      if (species) params.species = species;
      const result = await build(params, format);
      return ok({ ...result, rolledParams: roll });
    },

    async list_presets() {
      return ok(presets);
    },
  };

  server.registerTool('generate_tree', {
    title: 'Generate tree',
    description:
      'Generate a stylized low-poly tree. Start from a preset (optional) and override any params. Returns a short-lived download URL for the GLB (default), OBJ, or preset JSON, plus mesh and triangle counts.',
    inputSchema: {
      preset: z.enum(Object.keys(presets)).optional().describe('Preset to start from before applying overrides'),
      format: z.enum(FORMATS).optional().describe('Output format (default glb)'),
      ...paramShape,
    },
  }, handlers.generate_tree);

  server.registerTool('random_tree', {
    title: 'Random tree',
    description: 'Roll a random seed and shape (mirrors the app\'s "Random variation") and generate a tree.',
    inputSchema: {
      species: z.enum(SPECIES).optional(),
      rollSeed: z.number().int().min(1).max(999999).optional().describe('Seed used to roll the random params (not the tree seed)'),
      format: z.enum(FORMATS).optional(),
    },
  }, handlers.random_tree);

  server.registerTool('list_presets', {
    title: 'List presets',
    description: 'List the built-in tree presets and their parameters.',
    inputSchema: {},
  }, handlers.list_presets);

  return handlers;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/treegen.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/tools/treegen test/treegen.test.js
git commit -m "feat: vendor treegen and expose it as URL-returning remote tools"
```

---

### Task 3: HTTP server, transports, and the download route

**Files:**
- Create: `src/registry.js`
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `createArtifactStore` (Task 1), `registerTreegenTools` (Task 2)
- Produces:
  - `buildMcpServer(routeName, { store })` → configured `McpServer` (from `registry.js`)
  - `ROUTES` → `{ treegen: [...], assetcut: [] }` (from `registry.js`)
  - `createApp({ store })` → Express app (from `server.js`)

- [ ] **Step 1: Write the failing test**

Create `test/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createArtifactStore } from '../src/artifacts.js';
import { createApp } from '../src/server.js';

async function serve() {
  const dir = await mkdtemp(path.join(tmpdir(), 'server-test-'));
  const store = createArtifactStore({ dir, baseUrl: 'http://127.0.0.1' });
  const app = createApp({ store });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, close: () => new Promise((r) => server.close(r)) };
}

async function connect(base, route) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${route}`)));
  return client;
}

test('healthz reports ok', async () => {
  const { base, close } = await serve();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
  await close();
});

test('treegen route lists its three tools over streamable http', async () => {
  const { base, close } = await serve();
  const client = await connect(base, 'treegen');

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['generate_tree', 'list_presets', 'random_tree']);

  await client.close();
  await close();
});

test('generate_tree over the wire produces a downloadable glb', async () => {
  const { base, close } = await serve();
  const client = await connect(base, 'treegen');

  const result = await client.callTool({ name: 'generate_tree', arguments: { seed: 11, detail: 0 } });
  const payload = JSON.parse(result.content[0].text);

  const res = await fetch(payload.url.replace('http://127.0.0.1', base));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF');

  await client.close();
  await close();
});

test('out-of-range params are rejected by the schema', async () => {
  const { base, close } = await serve();
  const client = await connect(base, 'treegen');

  const result = await client.callTool({ name: 'generate_tree', arguments: { detail: 99 } });
  assert.equal(result.isError, true);

  await client.close();
  await close();
});

test('unknown artifact id is 404, expired is 410', async () => {
  const { base, store, close } = await serve();

  const missing = await fetch(`${base}/dl/${'0'.repeat(32)}.glb`);
  assert.equal(missing.status, 404);

  const entry = await store.put(Buffer.from('x'), 'glb');
  await store.sweep.call(store);
  // Force expiry by sweeping with a store whose ttl has passed is covered in
  // artifacts.test.js; here we assert the route maps 'expired' to 410.
  const expiredStore = createArtifactStore({
    dir: path.join(tmpdir(), 'never'),
    baseUrl: 'http://127.0.0.1',
    ttlMs: -1,
  });
  const stale = await expiredStore.put(Buffer.from('x'), 'glb');
  const app = createApp({ store: expiredStore });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/dl/${stale.id}.glb`);
  assert.equal(res.status, 410);
  await new Promise((r) => srv.close(r));

  assert.ok(entry.id);
  await close();
});

test('assetcut route is reachable but registers no tools in v1', async () => {
  const { base, close } = await serve();
  const client = await connect(base, 'assetcut');

  const { tools } = await client.listTools();
  assert.deepEqual(tools, []);

  await client.close();
  await close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 3: Implement the registry**

Create `src/registry.js`:

```js
// The only file that changes when a tool is added. Each route name maps to the
// list of register functions that populate it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTreegenTools } from './tools/treegen/index.js';

export const ROUTES = {
  // Public, unauthenticated: no file input, all params bounded.
  treegen: [registerTreegenTools],
  // Cloudflare Access-gated. Empty in v1 — the auth path is built and verified
  // now so landing assetcut later is an entry here, not an infra change.
  assetcut: [],
};

export function buildMcpServer(routeName, deps) {
  const register = ROUTES[routeName];
  if (!register) throw new Error(`Unknown route: ${routeName}`);

  const server = new McpServer({ name: `andreglegg-${routeName}`, version: '1.0.0' });
  for (const fn of register) fn(server, deps);
  return server;
}
```

- [ ] **Step 4: Implement the server**

Create `src/server.js`:

```js
import express from 'express';
import { createReadStream } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createArtifactStore } from './artifacts.js';
import { ROUTES, buildMcpServer } from './registry.js';

const ARTIFACT_ID = /^([a-f0-9]{32})\.[a-z0-9]+$/;

export function createApp({ store }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', routes: Object.keys(ROUTES) }));

  // Stateless MCP: a fresh server + transport per request, so concurrent
  // callers can never collide on request ids.
  for (const routeName of Object.keys(ROUTES)) {
    app.all(`/${routeName}`, express.json(), async (req, res) => {
      const server = buildMcpServer(routeName, { store });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on('close', () => {
        transport.close();
        server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: String(err?.message ?? err) });
      }
    });
  }

  app.get('/dl/:file', (req, res) => {
    const match = ARTIFACT_ID.exec(req.params.file);
    if (!match) return res.status(404).json({ error: 'Not found' });

    const entry = store.get(match[1]);
    if (entry.status === 'missing') return res.status(404).json({ error: 'Not found' });
    if (entry.status === 'expired') {
      return res.status(410).json({
        error: 'This artifact has expired. Generate it again — URLs are valid for 30 minutes.',
      });
    }

    res.setHeader('Content-Type', entry.contentType);
    createReadStream(entry.path).pipe(res);
  });

  return app;
}

// Entry point — only runs when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  const store = createArtifactStore({
    dir: process.env.ARTIFACT_DIR ?? new URL('../tmp/artifacts', import.meta.url).pathname,
    baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://mcp.andreglegg.no',
  });

  setInterval(() => { store.sweep().catch(() => {}); }, 5 * 60 * 1000).unref();

  createApp({ store }).listen(port, '127.0.0.1', () => {
    console.log(`mcp host listening on 127.0.0.1:${port}`);
  });
}
```

- [ ] **Step 5: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS — all tests across the three files.

- [ ] **Step 6: Commit**

```bash
git add src/registry.js src/server.js test/server.test.js
git commit -m "feat: serve mcp routes over streamable http with artifact downloads"
```

---

### Task 4: Publish the repo and deploy to the box

**Files:**
- Create: `README.md`
- Create: `update.ps1`
- Create: `tunnel/config.yml`

**Interfaces:**
- Consumes: a working server from Task 3 (`npm start` on port 8787)
- Produces: the service running on the box at `127.0.0.1:8787`, source at `%USERPROFILE%\mcp.andreglegg.no`

- [ ] **Step 1: Write the README**

Create `README.md`:

```markdown
# mcp.andreglegg.no

Remote MCP tool host. Serves my own tools over Streamable HTTP so any MCP
client can use them without a local install.

| Route | Auth | Tools |
|---|---|---|
| `/treegen` | none | `generate_tree`, `random_tree`, `list_presets` |
| `/assetcut` | Cloudflare Access service token | none yet |
| `/dl/<id>` | none | artifact downloads, 30 min TTL |

## Use it

    claude mcp add --transport http treegen https://mcp.andreglegg.no/treegen

## Run locally

    npm install
    npm test
    PUBLIC_BASE_URL=http://localhost:8787 npm start

## Architecture

Design and rationale — including why Cloudflare Workers was rejected and why
binaries are never returned inline — live in
`docs/superpowers/specs/2026-08-03-mcp-subdomain-design.md`.

Runs on an always-on Windows box behind a free Cloudflare Tunnel. The public
endpoint is only up when that box is up.

## Deploy

    ssh <host> "powershell -File %USERPROFILE%\\mcp.andreglegg.no\\update.ps1"
```

- [ ] **Step 2: Write the update script**

Create `update.ps1`:

```powershell
# Pull, install, restart. Run on the box: powershell -File update.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

git pull --ff-only
npm ci --omit=dev

Stop-ScheduledTask   -TaskName 'mcp-host' -ErrorAction SilentlyContinue
Start-ScheduledTask  -TaskName 'mcp-host'

Start-Sleep -Seconds 3
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 5
Write-Host "mcp-host is $($health.status), routes: $($health.routes -join ', ')"
```

- [ ] **Step 3: Write the tunnel config**

Create `tunnel/config.yml`:

```yaml
# Copied to %USERPROFILE%\.cloudflared\config.yml on the box.
# tunnel: and credentials-file: are filled in by Task 5 after the tunnel exists.
ingress:
  - hostname: mcp.andreglegg.no
    service: http://127.0.0.1:8787
  - service: http_status:404
```

- [ ] **Step 4: Create the GitHub repo and push**

```bash
gh repo create andreglegg/mcp.andreglegg.no --public \
  --description "Remote MCP tool host — my own tools over Streamable HTTP" \
  --source . --remote origin --push
```

- [ ] **Step 5: Clone and install on the box**

```bash
ssh <host> "git clone https://github.com/andreglegg/mcp.andreglegg.no.git %USERPROFILE%\mcp.andreglegg.no"
ssh <host> "cd %USERPROFILE%\mcp.andreglegg.no && npm ci --omit=dev"
```

- [ ] **Step 6: Register the startup task and start it**

```bash
ssh <host> "schtasks /Create /TN mcp-host /SC ONSTART /RL HIGHEST /F /TR \"node %USERPROFILE%\mcp.andreglegg.no\src\server.js\""
ssh <host> "schtasks /Run /TN mcp-host"
```

- [ ] **Step 7: Verify it answers locally on the box**

```bash
ssh <host> "curl -s http://127.0.0.1:8787/healthz"
```

Expected: `{"status":"ok","routes":["treegen","assetcut"]}`

- [ ] **Step 8: Commit**

```bash
git add README.md update.ps1 tunnel/config.yml
git commit -m "docs: add readme, deploy script, and tunnel config"
git push
```

---

### Task 5: Cloudflare Tunnel, DNS, and the Access gate

**Files:**
- Modify: `tunnel/config.yml` (fill in tunnel id and credentials path)

**Interfaces:**
- Consumes: the service answering on `127.0.0.1:8787` from Task 4
- Produces: `https://mcp.andreglegg.no/treegen` reachable publicly; `/assetcut` refused without a service token

**Blocking:** Step 1 opens a browser for Cloudflare login and cannot be automated. Andre must run it.

- [ ] **Step 1: Authenticate cloudflared (Andre runs this)**

```
ssh <host>
%USERPROFILE%\cloudflared.exe tunnel login
```

Pick `andreglegg.no` in the browser. Writes `%USERPROFILE%\.cloudflared\cert.pem`.

- [ ] **Step 2: Create the tunnel and DNS record**

```bash
ssh <host> "%USERPROFILE%\cloudflared.exe tunnel create mcp-andreglegg"
ssh <host> "%USERPROFILE%\cloudflared.exe tunnel route dns mcp-andreglegg mcp.andreglegg.no"
```

Note the tunnel UUID from the create output.

- [ ] **Step 3: Install the config and run cloudflared as a service**

Fill `tunnel/config.yml` with the UUID, then:

```bash
ssh <host> "copy %USERPROFILE%\mcp.andreglegg.no\tunnel\config.yml %USERPROFILE%\.cloudflared\config.yml"
ssh <host> "%USERPROFILE%\cloudflared.exe service install"
```

- [ ] **Step 4: Verify the public endpoint end to end**

```bash
curl -s https://mcp.andreglegg.no/healthz
```

Expected: `{"status":"ok","routes":["treegen","assetcut"]}`

Then connect a real client:

```bash
claude mcp add --transport http treegen https://mcp.andreglegg.no/treegen
```

Ask it to generate a tree and confirm the returned URL downloads a GLB.

- [ ] **Step 5: Gate /assetcut behind Access**

In the Cloudflare Zero Trust dashboard:
1. Access → Applications → Add a self-hosted application
2. Domain `mcp.andreglegg.no`, path `assetcut`
3. Policy: Action **Service Auth**, include a new service token named `mcp-assetcut`
4. Save the client id and secret

Verify the gate rejects anonymous traffic:

```bash
curl -s -o /dev/null -w "%{http_code}" https://mcp.andreglegg.no/assetcut
```

Expected: `403`

And that `/treegen` is untouched:

```bash
curl -s -o /dev/null -w "%{http_code}" https://mcp.andreglegg.no/healthz
```

Expected: `200`

- [ ] **Step 6: Add a rate-limiting rule**

Cloudflare dashboard → Security → WAF → Rate limiting rules. One rule on
`mcp.andreglegg.no`, 60 requests per minute per IP, action Block. This is the
single free-tier rule.

- [ ] **Step 7: Commit**

```bash
git add tunnel/config.yml
git commit -m "chore: pin tunnel id in cloudflared config"
git push
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Artifact contract (URL not path, 30 min TTL, temp dir cap) | 1 |
| Vendored treegen + `SOURCE.md` | 2 |
| Streamable HTTP, stateless | 3 |
| `/treegen` public, `/assetcut` present but empty | 3 (routes), 5 (gate) |
| 410 on expired artifact, 404 on missing | 1, 3 |
| Bounded params as the abuse control | 2 (schema), 3 (test) |
| Repo layout, GitHub as source of truth | 4 |
| `update.ps1`, Scheduled Task, cloudflared service | 4, 5 |
| DNS record | 5 |
| Rate limiting rule | 5 |
| Integration test asserting `glTF` magic | 3 |

No gaps.

**Known deviations from the spec, deliberate:**
- The spec's layout put `artifacts.js` alongside `server.js`; that holds.
- `outPath` existed on the local treegen tools and is **removed** rather than
  forwarded, since a remote caller writing arbitrary host paths is a hole. Task 2
  tests the rejection.
