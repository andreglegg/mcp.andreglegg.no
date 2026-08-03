// The other suites import createApp() directly, so they never exercise the
// `is this file the entry point?` guard. That guard was broken on Windows
// (file:///C:/... vs C:\...) and the process started nothing while still
// looking alive in tasklist. This spawns the real script the way the scheduled
// task does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

async function waitForHealth(port, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return await res.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server never started listening');
}

test('running src/server.js directly starts a listening server', async (t) => {
  const port = 18787;
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'entrypoint-test-'));

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ARTIFACT_DIR: artifactDir, PUBLIC_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); });

  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });

  const health = await waitForHealth(port, child).catch((err) => {
    throw new Error(`${err.message}\nstderr: ${stderr}`);
  });

  assert.equal(health.status, 'ok');
  assert.deepEqual(health.routes.sort(), ['assetcut', 'treegen']);
});
