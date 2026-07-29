import { decode } from 'light-bolt11-decoder';

export interface ParsedL402 {
  rail: 'l402';
  network: 'lightning';
  asset: 'BTC';
  amount: string;
  amountSats: number;
  payTo: null;
  credential: string;
  credentialKind: 'macaroon' | 'token';
  scheme: 'L402' | 'LSAT';
  invoice: string;
  raw: string;
  expiresAt: number | null;
}

export type ChallengeErrorCode = 'BAD_SCHEME' | 'MISSING_FIELDS' | 'BAD_INVOICE';

export class ChallengeError extends Error {
  readonly code: ChallengeErrorCode;

  constructor(code: ChallengeErrorCode, message: string) {
    super(message);
    this.name = 'ChallengeError';
    this.code = code;
  }
}

interface Segment {
  scheme: string;
  params: Map<string, string>;
}

const SNIPPET_LIMIT = 60;
const TOKEN_CHAR = /[A-Za-z0-9!#$%&'*+\-.^_`|~]/;
const SECRET_PARAM = /\b(macaroon|token|request)(\s*=\s*")[^"]*"/gi;

/**
 * Split a WWW-Authenticate value into scheme segments. fetch() comma-joins
 * repeated headers, and servers interleave unrelated schemes, so a bare
 * `key="value"` regex over the whole string attributes params to the wrong
 * scheme. A linear scan also guarantees we never split on '=' — base64
 * credentials carry '=' as padding.
 */
function splitSegments(header: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let i = 0;

  while (i < header.length) {
    const ch = header[i]!;
    if (ch === ',' || /\s/.test(ch)) {
      i += 1;
      continue;
    }

    const start = i;
    while (i < header.length && TOKEN_CHAR.test(header[i]!)) i += 1;
    if (i === start) {
      i += 1;
      continue;
    }
    const word = header.slice(start, i);

    let j = i;
    while (j < header.length && /\s/.test(header[j]!)) j += 1;

    if (header[j] !== '=') {
      current = { scheme: word, params: new Map() };
      segments.push(current);
      i = j;
      continue;
    }

    j += 1;
    while (j < header.length && /\s/.test(header[j]!)) j += 1;

    let value: string;
    if (header[j] === '"') {
      j += 1;
      let buf = '';
      while (j < header.length && header[j] !== '"') {
        if (header[j] === '\\' && j + 1 < header.length) {
          buf += header[j + 1];
          j += 2;
          continue;
        }
        buf += header[j];
        j += 1;
      }
      j += 1;
      value = buf;
    } else {
      const valueStart = j;
      while (j < header.length && header[j] !== ',') j += 1;
      value = header.slice(valueStart, j).trim();
    }

    if (current && !current.params.has(word.toLowerCase())) {
      current.params.set(word.toLowerCase(), value);
    }
    i = j;
  }

  return segments;
}

/**
 * Prefer the value carried by the L402 segment itself; fall back to any other
 * segment. Real servers scatter these across comma-joined challenge lines.
 */
function pickParam(primary: Segment, all: Segment[], key: string): string | undefined {
  const own = primary.params.get(key);
  if (own) return own;
  for (const segment of all) {
    const value = segment.params.get(key);
    if (value) return value;
  }
  return undefined;
}

function snippet(header: string): string {
  const redacted = header.replace(SECRET_PARAM, (_m, key: string, eq: string) => `${key}${eq}[redacted]"`);
  return redacted.length > SNIPPET_LIMIT ? `${redacted.slice(0, SNIPPET_LIMIT)}…` : redacted;
}

function fail(code: ChallengeErrorCode, reason: string, header: string): never {
  throw new ChallengeError(code, `${reason}: ${snippet(header)}`);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function bodySats(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  return positiveNumber(record.amountSats) ?? positiveNumber(record.price_sats);
}

function decodeInvoice(invoice: string, header: string): { sats: number; expiresAt: number | null } {
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(invoice);
  } catch {
    fail('BAD_INVOICE', 'invoice does not decode as bolt11', header);
  }

  const amount = decoded.sections.find((s) => s.name === 'amount');
  const msats = amount && 'value' in amount ? Number(amount.value) : NaN;
  if (!Number.isFinite(msats) || msats <= 0) {
    fail('BAD_INVOICE', 'invoice carries no amount', header);
  }

  const timestamp = decoded.sections.find((s) => s.name === 'timestamp');
  const seconds = timestamp && 'value' in timestamp ? Number(timestamp.value) : NaN;
  const expiry = Number(decoded.expiry);
  const expiresAt =
    Number.isFinite(seconds) && Number.isFinite(expiry) ? (seconds + expiry) * 1000 : null;

  return { sats: Math.ceil(msats / 1000), expiresAt };
}

export function parseL402Challenge(wwwAuthenticate: string, body: unknown): ParsedL402 {
  const header = typeof wwwAuthenticate === 'string' ? wwwAuthenticate : '';
  const segments = splitSegments(header);
  const primary = segments.find((s) => s.scheme.toUpperCase() === 'L402' || s.scheme.toUpperCase() === 'LSAT');

  if (!primary) {
    fail('BAD_SCHEME', 'no L402 or LSAT challenge in WWW-Authenticate', header);
  }

  const scheme = primary.scheme.toUpperCase() === 'LSAT' ? 'LSAT' : 'L402';
  const macaroon = pickParam(primary, segments, 'macaroon');
  const token = pickParam(primary, segments, 'token');
  const credential = macaroon ?? token;
  if (!credential) {
    fail('MISSING_FIELDS', 'challenge has neither macaroon nor token', header);
  }

  const invoice = pickParam(primary, segments, 'invoice');
  if (!invoice) {
    fail('MISSING_FIELDS', 'challenge has no invoice', header);
  }

  const { sats, expiresAt } = decodeInvoice(invoice, header);
  const amountSats = bodySats(body) ?? sats;

  return {
    rail: 'l402',
    network: 'lightning',
    asset: 'BTC',
    amount: String(amountSats),
    amountSats,
    payTo: null,
    credential,
    credentialKind: macaroon ? 'macaroon' : 'token',
    scheme,
    invoice,
    raw: header,
    expiresAt
  };
}
