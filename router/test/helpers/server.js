import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boots the router on an ephemeral port with an isolated data dir.
// Returns { baseUrl, close }.
export async function startRouter(env = {}) {
  process.env.ROUTER_DATA_DIR = env.ROUTER_DATA_DIR || mkdtempSync(join(tmpdir(), 'router-test-'));
  process.env.ROUTER_STATE_KEY = env.ROUTER_STATE_KEY || process.env.ROUTER_STATE_KEY || 'ab'.repeat(32);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const { createRouterApp } = await import('../../dist/index.js');
  const { app, shutdown } = createRouterApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await shutdown?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
