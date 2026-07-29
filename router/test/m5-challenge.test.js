import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from 'light-bolt11-decoder';
import { parseL402Challenge, ChallengeError } from '../dist/challenge.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

// Real bolt11 from the macaroon fixture: 500000 msat, timestamp 1785303713, expiry 600.
const MACAROON_FX = fixture('direct-l402-macaroon');
const TOKEN_FX = fixture('direct-l402-token');
const LSAT_FX = fixture('lsat-scheme');
const BOTH_FX = fixture('both-credentials');
const NON_L402_FX = fixture('non-l402-scheme');

function invoiceOf(fx) {
  return fx.wwwAuthenticate.match(/invoice="([^"]+)"/)[1];
}

// BOLT11 spec test vector: valid invoice carrying NO amount section.
const AMOUNTLESS_INVOICE =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2' +
  'ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2' +
  'ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w';

test('M5a: direct L402 macaroon challenge with a TEXT body derives sats purely from the bolt11', () => {
  const parsed = parseL402Challenge(MACAROON_FX.wwwAuthenticate, MACAROON_FX.body);

  assert.equal(parsed.rail, 'l402');
  assert.equal(parsed.network, 'lightning');
  assert.equal(parsed.asset, 'BTC');
  assert.equal(parsed.scheme, 'L402');
  assert.equal(parsed.payTo, null);
  assert.equal(parsed.amountSats, 500, '500000 msat / 1000');
  assert.equal(parsed.amount, '500');
  assert.equal(typeof parsed.amount, 'string');
  assert.equal(parsed.credentialKind, 'macaroon');
  // Rule 3: base64 '=' padding must survive — proof the parser never split on '='.
  assert.equal(parsed.credential, 'MDAxOWxvY2F0aW9uIHByb2JlTRUNCATEDFAKE=');
  assert.ok(parsed.credential.endsWith('='), 'trailing base64 padding preserved');
  assert.equal(parsed.invoice, invoiceOf(MACAROON_FX));
  assert.equal(parsed.raw, MACAROON_FX.wwwAuthenticate, 'raw is the full header value');
  // timestamp 1785303713 + expiry 600, epoch milliseconds.
  assert.equal(parsed.expiresAt, (1785303713 + 600) * 1000);
});

test('M5b: token challenge — body.price_sats and the header bolt11 agree on 500', () => {
  const parsed = parseL402Challenge(TOKEN_FX.wwwAuthenticate, TOKEN_FX.body);

  assert.equal(parsed.credentialKind, 'token');
  assert.equal(parsed.credential, 'eyJpZGVudGlmaWVyIjoiZGRjTRUNCATEDFAKE=');
  assert.equal(parsed.scheme, 'L402');
  assert.equal(parsed.amountSats, 500);
  assert.equal(parsed.amount, '500');

  // Both derivation paths must land on the same number.
  assert.equal(TOKEN_FX.body.price_sats, 500, 'body path');
  const msat = decode(invoiceOf(TOKEN_FX)).sections.find((s) => s.name === 'amount').value;
  assert.equal(Number(msat) / 1000, 500, 'bolt11 path');
  assert.equal(parsed.amountSats, Number(msat) / 1000, 'body and bolt11 agree');
});

test('M5c: LSAT scheme is accepted and keeps its scheme label', () => {
  const parsed = parseL402Challenge(LSAT_FX.wwwAuthenticate, LSAT_FX.body);

  assert.equal(parsed.scheme, 'LSAT');
  assert.equal(parsed.rail, 'l402');
  assert.equal(parsed.credentialKind, 'macaroon');
  assert.equal(parsed.credential, 'AgEEbHNhdAJCAACMSvhWLR8PTRUNCATEDFAKE=');
  assert.equal(parsed.amountSats, 2000, '2000000 msat / 1000');
  assert.equal(parsed.amount, '2000');
});

test('M5d: a non-L402 scheme is rejected with BAD_SCHEME, never guessed at', () => {
  assert.throws(
    () => parseL402Challenge(NON_L402_FX.wwwAuthenticate, NON_L402_FX.body),
    (err) => err instanceof ChallengeError && err.code === 'BAD_SCHEME'
  );
  assert.throws(
    () => parseL402Challenge('Basic realm="x"', ''),
    (err) => err instanceof ChallengeError && err.code === 'BAD_SCHEME'
  );
});

test('M5e: scheme match is case-insensitive but the reported scheme is normalized', () => {
  const lower = LSAT_FX.wwwAuthenticate.replace(/^LSAT/, 'lsat');
  assert.equal(parseL402Challenge(lower, '').scheme, 'LSAT');

  const mixed = MACAROON_FX.wwwAuthenticate.replace(/^L402/, 'l402');
  assert.equal(parseL402Challenge(mixed, '').scheme, 'L402');
});

test('M5f: when macaroon AND token are both present, macaroon wins', () => {
  const fromFixture = parseL402Challenge(BOTH_FX.wwwAuthenticate, BOTH_FX.body);
  assert.equal(fromFixture.credentialKind, 'macaroon');
  assert.equal(fromFixture.credential, 'MDAxOWxvY2F0aW9uIHByb2JlTRUNCATEDFAKE=');

  // Same rule when both sit in one L402 segment, token listed first.
  const header = `L402 token="TOKENVALUE==", macaroon="MACVALUE==", invoice="${invoiceOf(MACAROON_FX)}"`;
  const parsed = parseL402Challenge(header, '');
  assert.equal(parsed.credentialKind, 'macaroon');
  assert.equal(parsed.credential, 'MACVALUE==');
});

test('M5g: comma-joined multi-scheme header (fetch() join) parses the first L402/LSAT segment', () => {
  const joined = `${LSAT_FX.wwwAuthenticate}, ${MACAROON_FX.wwwAuthenticate}`;
  const parsed = parseL402Challenge(joined, '');

  assert.equal(parsed.scheme, 'LSAT', 'first L402/LSAT segment wins');
  assert.equal(parsed.credential, 'AgEEbHNhdAJCAACMSvhWLR8PTRUNCATEDFAKE=');
  assert.equal(parsed.amountSats, 2000);
  assert.equal(parsed.raw, joined);

  // Non-L402 scheme first must be skipped, not fatal.
  const trailing = `${NON_L402_FX.wwwAuthenticate}, ${LSAT_FX.wwwAuthenticate}`;
  assert.equal(parseL402Challenge(trailing, '').scheme, 'LSAT');
});

test('M5h: space-separated params parse, and values are never split on "="', () => {
  const invoice = invoiceOf(MACAROON_FX);
  const spaced = `L402 macaroon="AAAA==BBBB=" invoice="${invoice}"`;
  const parsed = parseL402Challenge(spaced, '');

  assert.equal(parsed.credential, 'AAAA==BBBB=', 'interior and trailing "=" intact');
  assert.equal(parsed.invoice, invoice);
  assert.equal(parsed.amountSats, 500);
});

test('M5i: body.amountSats (gateway re-quote) outranks price_sats and the bolt11', () => {
  const header = MACAROON_FX.wwwAuthenticate; // invoice says 500
  assert.equal(parseL402Challenge(header, { amountSats: 750, price_sats: 600 }).amountSats, 750);
  assert.equal(parseL402Challenge(header, { price_sats: 600 }).amountSats, 600);

  // Non-numeric values must not be trusted — fall through to the next source.
  assert.equal(parseL402Challenge(header, { amountSats: '750', price_sats: 600 }).amountSats, 600);
  assert.equal(parseL402Challenge(header, { amountSats: null, price_sats: null }).amountSats, 500);
  assert.equal(parseL402Challenge(header, 'Payment required').amountSats, 500);
});

test('M5j: a missing invoice or a missing credential is MISSING_FIELDS', () => {
  assert.throws(
    () => parseL402Challenge('L402 macaroon="MDAxOWxvY2F0aW9u="', 'nope'),
    (err) => err instanceof ChallengeError && err.code === 'MISSING_FIELDS'
  );
  assert.throws(
    () => parseL402Challenge(`L402 invoice="${invoiceOf(MACAROON_FX)}"`, 'nope'),
    (err) => err instanceof ChallengeError && err.code === 'MISSING_FIELDS'
  );
});

test('M5k: an undecodable invoice or one with no amount is BAD_INVOICE', () => {
  assert.throws(
    () => parseL402Challenge('L402 macaroon="AAA=", invoice="not-a-real-invoice"', ''),
    (err) => err instanceof ChallengeError && err.code === 'BAD_INVOICE'
  );
  assert.throws(
    () => parseL402Challenge(`L402 macaroon="AAA=", invoice="${AMOUNTLESS_INVOICE}"`, ''),
    (err) => err instanceof ChallengeError && err.code === 'BAD_INVOICE',
    'valid bolt11 with no amount section cannot price a job'
  );
});

test('M5l: error messages never leak the credential and stay bounded', () => {
  const longMacaroon = `${'MDAxOWxvY2F0aW9uIHByb2JlZGVhZGJlZWY'.repeat(9)}==`;
  assert.ok(longMacaroon.length > 300);

  let caught;
  try {
    parseL402Challenge(`L402 macaroon="${longMacaroon}"`, '');
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof ChallengeError);
  assert.equal(caught.code, 'MISSING_FIELDS');
  assert.ok(!caught.message.includes(longMacaroon), 'full credential must not appear');
  assert.ok(
    !caught.message.includes(longMacaroon.slice(0, 40)),
    'not even a prefix of the credential may appear'
  );
  assert.ok(caught.message.length <= 200, `message bounded, got ${caught.message.length}`);
});

test('M5m: expiresAt is the bolt11 timestamp + expiry, in epoch milliseconds', () => {
  const decoded = decode(invoiceOf(LSAT_FX));
  const timestamp = decoded.sections.find((s) => s.name === 'timestamp').value;
  assert.equal(timestamp, 1785303713);
  assert.equal(decoded.expiry, 86400);
  assert.equal(parseL402Challenge(LSAT_FX.wwwAuthenticate, '').expiresAt, (timestamp + 86400) * 1000);
});

test('M5n: garbage input is a typed ChallengeError, not a TypeError', () => {
  for (const bad of ['', '   ', 'L402']) {
    assert.throws(
      () => parseL402Challenge(bad, ''),
      (err) => err instanceof ChallengeError,
      `input ${JSON.stringify(bad)} must throw ChallengeError`
    );
  }
});
