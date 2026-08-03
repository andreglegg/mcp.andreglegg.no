import express from 'express';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createArtifactStore } from './artifacts.js';
import { ROUTES, buildMcpServer } from './registry.js';

const ARTIFACT_ID = /^([a-f0-9]{32})\.[a-z0-9]+$/;

// The showcase site at tools.andreglegg.no is a browser origin, so it needs
// CORS to read /healthz and to make live MCP calls. Deliberately an allowlist:
// this is not a public API and `*` would let any page drive the server.
const ALLOWED_ORIGINS = new Set([
  'https://tools.andreglegg.no',
  'http://localhost:5173', // vite dev
  'http://localhost:4173', // vite preview
]);

export function createApp({ store }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

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
// Compare real filesystem paths: on Windows import.meta.url is
// file:///C:/... while argv[1] is C:\..., so a string compare never matches
// and the server would silently start nothing.
const thisFile = fileURLToPath(import.meta.url);
const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === thisFile;

if (isEntryPoint) {
  const port = Number(process.env.PORT ?? 8787);
  const store = createArtifactStore({
    dir: process.env.ARTIFACT_DIR ?? path.join(path.dirname(thisFile), '..', 'tmp', 'artifacts'),
    baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://mcp.andreglegg.no',
  });

  setInterval(() => { store.sweep().catch(() => {}); }, 5 * 60 * 1000).unref();

  createApp({ store }).listen(port, '127.0.0.1', () => {
    console.log(`mcp host listening on 127.0.0.1:${port}`);
  });
}
