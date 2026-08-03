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
