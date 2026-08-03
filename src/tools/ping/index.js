// Every route needs at least one tool. The MCP SDK only advertises the `tools`
// capability once something is registered, so a route with none answers
// tools/list with "Method not found" — worse than not existing. `ping` keeps a
// route a real, listable MCP endpoint while its real tools are still pending,
// and doubles as the liveness check through whatever auth sits in front of it.
export function registerPingTools(server, { routeName }) {
  const handlers = {
    async ping() {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ route: routeName, status: 'ok', tools: 'none yet' }, null, 2),
        }],
      };
    },
  };

  server.registerTool('ping', {
    title: 'Ping',
    description: `Liveness check for the ${routeName} route. Returns immediately; takes no arguments.`,
    inputSchema: {},
  }, handlers.ping);

  return handlers;
}
