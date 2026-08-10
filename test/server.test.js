import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createArtifactStore } from '../src/artifacts.js';
import { createApp } from '../src/server.js';

// Cleanup is registered on the test context, not left to the end of the test
// body — a failing assert must not leak an open socket and hang the whole file.
async function serve(t, storeOverrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'server-test-'));
  const store = createArtifactStore({ dir, baseUrl: 'http://127.0.0.1', ...storeOverrides });
  const server = createApp({ store }).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => {
    // closeAllConnections first: close() alone waits for keep-alive sockets the
    // MCP client still holds, which deadlocks against its own later cleanup.
    server.closeAllConnections();
    server.close(r);
  }));
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

async function connect(t, base, route) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${route}`)));
  t.after(() => client.close());
  return client;
}

test('healthz reports ok', async (t) => {
  const { base } = await serve(t);
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('treegen route lists its five tools over streamable http', async (t) => {
  const { base } = await serve(t);
  const client = await connect(t, base, 'treegen');

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    ['export_forest', 'export_game_tree', 'generate_tree', 'list_presets', 'random_tree']
  );
});

test('generate_tree over the wire produces a downloadable glb', async (t) => {
  const { base } = await serve(t);
  const client = await connect(t, base, 'treegen');

  const result = await client.callTool({ name: 'generate_tree', arguments: { seed: 11, detail: 0 } });
  const payload = JSON.parse(result.content[0].text);

  const res = await fetch(payload.url.replace('http://127.0.0.1', base));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF');
});

test('out-of-range params are rejected by the schema', async (t) => {
  const { base } = await serve(t);
  const client = await connect(t, base, 'treegen');

  const result = await client.callTool({ name: 'generate_tree', arguments: { detail: 99 } });
  assert.equal(result.isError, true);
});

test('unknown artifact id is 404', async (t) => {
  const { base } = await serve(t);
  const res = await fetch(`${base}/dl/${'0'.repeat(32)}.glb`);
  assert.equal(res.status, 404);
});

test('malformed artifact id is 404, not a path traversal', async (t) => {
  const { base } = await serve(t);
  const res = await fetch(`${base}/dl/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(res.status, 404);
});

test('expired artifact is 410 with a regenerate hint', async (t) => {
  // ttlMs of -1 makes every put expire the instant it lands.
  const { base, store } = await serve(t, { ttlMs: -1 });
  const stale = await store.put(Buffer.from('x'), 'glb');

  const res = await fetch(`${base}/dl/${stale.id}.glb`);
  assert.equal(res.status, 410);
  assert.match((await res.json()).error, /expired/i);
});

test('assetcut route is a real mcp endpoint with only ping in v1', async (t) => {
  const { base } = await serve(t);
  const client = await connect(t, base, 'assetcut');

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['ping']);

  const result = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).route, 'assetcut');
});

test('cors is granted to the tools origin and withheld from others', async (t) => {
  const { base } = await serve(t);

  const allowed = await fetch(`${base}/healthz`, { headers: { Origin: 'https://tools.andreglegg.no' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://tools.andreglegg.no');

  const denied = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('cors preflight on the mcp route is answered', async (t) => {
  const { base } = await serve(t);
  const res = await fetch(`${base}/treegen`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://tools.andreglegg.no', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});
