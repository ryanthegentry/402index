import { join } from 'node:path';

export interface RouterConfig {
  port: number;
  dataDir: string;
  stateKeyHex: string;
  stripeSecretKey: string;
  settlementAdapter: 'golem' | 'mock' | 'golem-http';
  golemHttpUrl: string;
  golemHttpApiKey: string;
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
  // 'required' rejects any /mcp request without a valid bearer token and is
  // mandatory for any non-loopback bind — the settlement path must never sit
  // on an open port unauthenticated.
  authMode: 'required' | 'off';
  bindHost: string;
  // per-principal cap defaults; a token row may override per token. Defaults
  // equal the global caps, so nothing changes until a deployment sets them.
  principalMaxSatsPerJob: number;
  principalMaxTotalSats: number;
  // minutes between scheduled credential-recovery passes; 0 disables
  retryIntervalMinutes: number;
  // public base URL of this deployment (setup redirects + mcp add snippet);
  // empty falls back to the requesting host
  publicUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const stateKeyHex = env.ROUTER_STATE_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(stateKeyHex)) {
    throw new Error('ROUTER_STATE_KEY must be 64 hex chars (openssl rand -hex 32)');
  }
  const authMode = env.ROUTER_AUTH_MODE === 'required' ? 'required' : 'off';
  const bindHost = env.ROUTER_BIND_HOST || '127.0.0.1';
  if (authMode !== 'required' && !['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
    throw new Error(
      `ROUTER_BIND_HOST=${bindHost} is non-loopback but ROUTER_AUTH_MODE is not 'required' — ` +
        'refusing to expose the settlement path on an open port without bearer auth'
    );
  }
  const maxSatsPerJob = Number(env.ROUTER_MAX_SATS_PER_JOB || 2000);
  const maxTotalSats = Number(env.ROUTER_MAX_TOTAL_SATS || 20000);
  const settlementAdapter =
    env.SETTLEMENT_ADAPTER === 'mock' ? 'mock' : env.SETTLEMENT_ADAPTER === 'golem-http' ? 'golem-http' : 'golem';
  const golemHttpUrl = env.GOLEM_HTTP_URL || '';
  const golemHttpApiKey = env.GOLEM_HTTP_API_KEY || '';
  if (settlementAdapter === 'golem-http' && (!golemHttpUrl || !golemHttpApiKey)) {
    throw new Error('SETTLEMENT_ADAPTER=golem-http requires GOLEM_HTTP_URL and GOLEM_HTTP_API_KEY');
  }
  return {
    port: Number(env.ROUTER_PORT || env.PORT || 4402),
    dataDir: env.ROUTER_DATA_DIR || join(import.meta.dirname, '..', 'data'),
    stateKeyHex,
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    settlementAdapter,
    golemHttpUrl,
    golemHttpApiKey,
    maxSatsPerJob,
    maxTotalSats,
    golemCliDir: env.GOLEM_CLI_DIR || join(process.env.HOME || '', 'workspace', 'projects', 'golem'),
    stateTtlSeconds: Number(env.ROUTER_STATE_TTL_SECONDS || 90),
    provenFallbacks: (env.ROUTER_PROVEN_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean),
    routeOrder: (env.ROUTER_ROUTE_ORDER || 'direct-l402,l402space').split(',').map((s) => s.trim()).filter(Boolean),
    legacyMode: env.ROUTER_LEGACY_MODE === 'stateless' ? 'stateless' : 'reject',
    authMode,
    bindHost,
    principalMaxSatsPerJob: Number(env.ROUTER_PRINCIPAL_MAX_SATS_PER_JOB || maxSatsPerJob),
    principalMaxTotalSats: Number(env.ROUTER_PRINCIPAL_MAX_TOTAL_SATS || maxTotalSats),
    retryIntervalMinutes: Number(env.ROUTER_RETRY_INTERVAL_MINUTES || 0),
    publicUrl: env.ROUTER_PUBLIC_URL || ''
  };
}
