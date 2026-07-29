import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { loadConfig, type RouterConfig } from './config.js';
import { openRouterDb } from './db.js';
import { createGuards } from './guards.js';
import { createLedger } from './ledger.js';
import { createBilling } from './billing/stripe.js';
import {
  buildRegistry,
  createAdapterRegistry,
  type SettlementAdapter,
  type AdapterRegistry
} from './settlement/index.js';
import { buildRoutes } from './routes/index.js';
import { btcUsdRate } from './btcprice.js';
import { registerInvokeTool, type InvokeDeps } from './tools/invoke.js';

export interface RouterOverrides {
  billing?: InvokeDeps['billing'];
  // single-adapter override, wrapped in a registry; test doubles may be partial
  adapter?: Partial<SettlementAdapter> & { name: string; minSats: number };
  registry?: AdapterRegistry;
  fetchImpl?: typeof fetch;
  btcUsd?: () => Promise<number>;
  redeemTimeoutMs?: number;
  checkoutUrlFactory?: InvokeDeps['checkoutUrlFactory'];
}

function registryFor(config: RouterConfig, overrides: RouterOverrides): AdapterRegistry {
  if (overrides.registry) return overrides.registry;
  if (overrides.adapter) {
    // test doubles may implement only part of the surface; fill the rest
    const a = overrides.adapter;
    const fallbackPayInvoice: SettlementAdapter['payInvoice'] = async () => {
      throw new Error('adapter override has no payInvoice');
    };
    const normalized: SettlementAdapter = {
      name: a.name,
      minSats: a.minSats,
      rails: a.rails ?? ['l402'],
      networks: a.networks ?? ['*'],
      movesRealFunds: a.movesRealFunds ?? false,
      canSettle: a.canSettle ?? ((req) => req.rail === 'l402'),
      payInvoice: a.payInvoice ?? fallbackPayInvoice,
      pay: a.pay ?? ((req, opts) => (a.payInvoice ?? fallbackPayInvoice)(req.raw, opts))
    };
    const registry = createAdapterRegistry({ pinned: normalized.name });
    registry.register(normalized);
    return registry;
  }
  return buildRegistry(config);
}

export function buildServer(deps: InvokeDeps): McpServer {
  const server = new McpServer({ name: '402index-router', version: '0.2.0' });
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
    ledger: createLedger(routerDb),
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
    registry: registryFor(config, overrides),
    routes: buildRoutes(config.routeOrder),
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
    console.log(
      `402index router listening on http://127.0.0.1:${config.port}/mcp ` +
        `(settlement: ${config.settlementAdapter}, routes: ${config.routeOrder.join(' → ')})`
    );
  });
}
