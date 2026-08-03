// The only file that changes when a tool is added. Each route name maps to the
// list of register functions that populate it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTreegenTools } from './tools/treegen/index.js';
import { registerPingTools } from './tools/ping/index.js';

export const ROUTES = {
  // Public, unauthenticated: no file input, all params bounded.
  treegen: [registerTreegenTools],
  // Cloudflare Access-gated. Only `ping` in v1 — the auth path is built and
  // verified now so landing assetcut later is an entry here, not an infra
  // change. A route cannot be empty: the SDK won't advertise tools/list at all
  // unless something is registered.
  assetcut: [registerPingTools],
};

export function buildMcpServer(routeName, deps) {
  const register = ROUTES[routeName];
  if (!register) throw new Error(`Unknown route: ${routeName}`);

  const server = new McpServer({ name: `andreglegg-${routeName}`, version: '1.0.0' });
  for (const fn of register) fn(server, { ...deps, routeName });
  return server;
}
