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
