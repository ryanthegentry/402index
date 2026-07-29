import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

const IV_BYTES = 12;
const TAG_BYTES = 16;

// Opaque state handed to the client between MRTR round trips. The client echoes it
// back verbatim, so on re-entry every field is attacker-controlled until GCM says otherwise.
export interface StatePayload {
  principal: string;
  upstream: string;
  serviceId: string;
  argsDigest: string;
  quotedSats: number;
  quotedUsd: number;
  paymentIntentId: string;
  issuedAt: number;
  ttlSeconds: number;
  nonce: string;
}

export type StateErrorCode = 'INTEGRITY' | 'EXPIRED' | 'PRINCIPAL' | 'DIGEST' | 'REPLAY';

export class StateError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

function parseKey(keyHex: string): Buffer {
  // Buffer.from(hex) silently truncates on bad input, so validate before converting.
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('router state key must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

export function canonicalArgsDigest(args: unknown): string {
  // JSON.stringify yields undefined (not a string) for undefined/function inputs.
  const json = JSON.stringify(canonicalize(args)) ?? 'null';
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

export function mintState(keyHex: string, payload: StatePayload): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

function isStatePayload(value: unknown): value is StatePayload {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.principal === 'string' &&
    typeof p.upstream === 'string' &&
    typeof p.serviceId === 'string' &&
    typeof p.argsDigest === 'string' &&
    typeof p.quotedSats === 'number' &&
    typeof p.quotedUsd === 'number' &&
    typeof p.paymentIntentId === 'string' &&
    Number.isFinite(p.issuedAt as number) &&
    Number.isFinite(p.ttlSeconds as number) &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0
  );
}

function decodeState(key: Buffer, blob: string): StatePayload {
  // Buffer.from(<number>) allocates instead of throwing, so reject non-strings up front.
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new StateError('INTEGRITY', 'state is not a non-empty string');
  }
  let parsed: unknown;
  try {
    const raw = Buffer.from(blob, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('state is too short to contain iv+tag');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final()
    ]);
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new StateError('INTEGRITY', 'state failed authenticated decryption');
  }
  if (!isStatePayload(parsed)) throw new StateError('INTEGRITY', 'state payload is malformed');
  return parsed;
}

export function verifyState(
  keyHex: string,
  db: Database.Database,
  blob: string,
  expect: { principal: string; argsDigest: string; now?: number }
): StatePayload {
  const key = parseKey(keyHex);
  const payload = decodeState(key, blob);

  const now = expect.now ?? Math.floor(Date.now() / 1000);
  if (now > payload.issuedAt + payload.ttlSeconds) {
    throw new StateError('EXPIRED', 'state has expired');
  }
  if (payload.principal !== expect.principal) {
    throw new StateError('PRINCIPAL', 'state was issued to a different principal');
  }
  if (payload.argsDigest !== expect.argsDigest) {
    throw new StateError('DIGEST', 'state was issued for different tool arguments');
  }

  // Single-use: the insert is the claim. changes === 0 means someone already claimed it.
  const claimed = db
    .prepare('INSERT OR IGNORE INTO state_nonces (nonce) VALUES (@nonce)')
    .run({ nonce: payload.nonce });
  if (claimed.changes === 0) {
    throw new StateError('REPLAY', 'state nonce has already been used');
  }

  return payload;
}
