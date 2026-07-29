import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

// Bearer-token identity for the hosted router (PRD D3/D9). The token IS the
// principal: issuance returns the raw value exactly once, storage keeps only
// its SHA-256, and revocation is by value — no accounts, no email. On an
// authenticated deployment clientInfo.name is never an identity source; on a
// 2025-era stateless connection it does not even arrive.

export interface AuthPrincipal {
  principal: string;
  // per-token cap overrides; null falls back to the config-level defaults
  maxSatsPerJob: number | null;
  maxTotalSats: number | null;
}

// Carries the authenticated principal from the HTTP layer into the tool
// handler without threading it through the MCP SDK's request surface.
export const authContext = new AsyncLocalStorage<AuthPrincipal>();

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function issueToken(
  db: Database,
  principal: string,
  limits: { maxSatsPerJob?: number; maxTotalSats?: number } = {}
): string {
  const raw = `402r_${randomBytes(24).toString('hex')}`;
  db.prepare(
    'INSERT INTO tokens (token_hash, principal, max_sats_per_job, max_total_sats) VALUES (?, ?, ?, ?)'
  ).run(hashToken(raw), principal, limits.maxSatsPerJob ?? null, limits.maxTotalSats ?? null);
  return raw;
}

export function revokeToken(db: Database, rawToken: string): boolean {
  const res = db
    .prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL")
    .run(hashToken(rawToken));
  return res.changes > 0;
}

export function resolveToken(db: Database, authorization: string | undefined): AuthPrincipal | null {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const raw = authorization.slice('Bearer '.length).trim();
  if (raw.length === 0) return null;
  const row = db
    .prepare('SELECT principal, max_sats_per_job, max_total_sats FROM tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(raw)) as { principal: string; max_sats_per_job: number | null; max_total_sats: number | null } | undefined;
  if (!row) return null;
  return { principal: row.principal, maxSatsPerJob: row.max_sats_per_job, maxTotalSats: row.max_total_sats };
}
