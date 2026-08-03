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
