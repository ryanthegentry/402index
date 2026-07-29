import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { loadConfig, type RouterConfig } from './config.js';
import { openRouterDb } from './db.js';
import { createGuards } from './guards.js';
import { createBilling } from './billing/stripe.js';
import { selectAdapter } from './settlement/index.js';
import { btcUsdRate } from './btcprice.js';
import { registerInvokeTool, type InvokeDeps } from './tools/invoke.js';

export interface RouterOverrides {
  billing?: InvokeDeps['billing'];
  adapter?: InvokeDeps['adapter'];
  fetchImpl?: typeof fetch;
  btcUsd?: () => Promise<number>;
  redeemTimeoutMs?: number;
  checkoutUrlFactory?: InvokeDeps['checkoutUrlFactory'];
}

export function buildServer(deps: InvokeDeps): McpServer {
  const server = new McpServer({ name: '402index-router', version: '0.1.0' });
  registerInvokeTool(server, deps);
  return server;
}

export function createRouterApp(
  config: RouterConfig = loadConfig(),
  overrides: RouterOverrides = {}
): { app: Express; shutdown: () => Promise<void>; routerDb: Database } {
  const routerDb = openRouterDb(config.dataDir);
  const deps: InvokeDeps = {
    config,
    routerDb,
    guards: createGuards(routerDb, { maxSatsPerJob: config.maxSatsPerJob, maxTotalSats: config.maxTotalSats }),
    // Without a key (e.g. CI without secrets) the server still boots; any
    // invoke that reaches billing fails with a clear error instead.
    billing:
      overrides.billing ??
      (config.stripeSecretKey
        ? createBilling(config.stripeSecretKey)
        : {
            authorize: async () => {
              throw new Error('STRIPE_SECRET_KEY is not set — billing unavailable');
            },
            capture: async () => ({ status: 'unavailable' }),
            void: async () => ({ status: 'unavailable' })
          }),
    adapter: overrides.adapter ?? selectAdapter(config),
    fetchImpl: overrides.fetchImpl ?? fetch,
    btcUsd: overrides.btcUsd ?? (() => btcUsdRate()),
    redeemTimeoutMs: overrides.redeemTimeoutMs,
    checkoutUrlFactory: overrides.checkoutUrlFactory
  };
  const handler = createMcpHandler(() => buildServer(deps), { legacy: 'reject' });
  const app = createMcpExpressApp();
  const nodeHandler = toNodeHandler(handler);
  // express.json() has already drained the stream; hand the parsed body over explicitly.
  app.all('/mcp', (req, res) => nodeHandler(req, res, req.body));
  return {
    app,
    routerDb,
    shutdown: async () => {
      await handler.close();
      routerDb.close();
    }
  };
}

const isMain = process.argv[1] && import.meta.filename === process.argv[1];
if (isMain) {
  const config = loadConfig();
  const { app } = createRouterApp(config);
  app.listen(config.port, '127.0.0.1', () => {
    console.log(`402index router listening on http://127.0.0.1:${config.port}/mcp (settlement: ${config.settlementAdapter})`);
  });
}
