import { join } from 'node:path';

export interface RouterConfig {
  port: number;
  dataDir: string;
  stateKeyHex: string;
  stripeSecretKey: string;
  settlementAdapter: 'golem' | 'mock';
  maxSatsPerJob: number;
  maxTotalSats: number;
  golemCliDir: string;
  stateTtlSeconds: number;
  provenFallbacks: string[];
  routeOrder: string[];
  // 'reject' serves only MCP 2026-07-28. 'stateless' also serves 2025-era
  // clients, where the SDK's legacy shim fulfils input_required with real
  // server→client elicitation and handler re-entry — the same handler code
  // serving both eras. Every deployed client today is 2025-era.
  legacyMode: 'reject' | 'stateless';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const stateKeyHex = env.ROUTER_STATE_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(stateKeyHex)) {
    throw new Error('ROUTER_STATE_KEY must be 64 hex chars (openssl rand -hex 32)');
  }
  return {
    port: Number(env.ROUTER_PORT || 4402),
    dataDir: env.ROUTER_DATA_DIR || join(import.meta.dirname, '..', 'data'),
    stateKeyHex,
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    settlementAdapter: env.SETTLEMENT_ADAPTER === 'mock' ? 'mock' : 'golem',
    maxSatsPerJob: Number(env.ROUTER_MAX_SATS_PER_JOB || 2000),
    maxTotalSats: Number(env.ROUTER_MAX_TOTAL_SATS || 20000),
    golemCliDir: env.GOLEM_CLI_DIR || join(process.env.HOME || '', 'workspace', 'projects', 'golem'),
    stateTtlSeconds: Number(env.ROUTER_STATE_TTL_SECONDS || 90),
    provenFallbacks: (env.ROUTER_PROVEN_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean),
    routeOrder: (env.ROUTER_ROUTE_ORDER || 'direct-l402,l402space').split(',').map((s) => s.trim()).filter(Boolean),
    legacyMode: env.ROUTER_LEGACY_MODE === 'stateless' ? 'stateless' : 'reject'
  };
}
