import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRouterDb } from '../dist/db.js';
import { canonicalArgsDigest, mintState, verifyState, StateError } from '../dist/state.js';

// Never the real key: fixed dummy 32 bytes.
const KEY = 'ab'.repeat(32);
const PRINCIPAL = 'scripted-test-client:client-abc123';
const ARGS = { query: 'weather in NYC', units: 'metric' };

function freshDb(t) {
  const db = openRouterDb(mkdtempSync(join(tmpdir(), 'router-state-test-')));
  t.after(() => db.close());
  return db;
}

function samplePayload(overrides = {}) {
  return {
    principal: PRINCIPAL,
    upstream: 'https://upstream.example/api/v1/weather',
    serviceId: 'svc_weather_001',
    argsDigest: canonicalArgsDigest(ARGS),
    quotedSats: 210,
    quotedUsd: 0.14,
    paymentIntentId: 'pi_test_12345',
    issuedAt: Math.floor(Date.now() / 1000),
    ttlSeconds: 90,
    nonce: 'ff'.repeat(16),
    ...overrides
  };
}

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof StateError, `expected StateError, got ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, code);
    return true;
  };
}

test('T2a: mintState round-trips through verifyState with the payload intact', (t) => {
  const db = freshDb(t);
  const payload = samplePayload();
  const blob = mintState(KEY, payload);

  assert.equal(typeof blob, 'string');
  assert.ok(blob.length > 0, 'blob is non-empty');

  const verified = verifyState(KEY, db, blob, {
    principal: PRINCIPAL,
    argsDigest: canonicalArgsDigest(ARGS)
  });

  assert.deepEqual(verified, payload);
});

test('T2b: a tampered blob is rejected with INTEGRITY', (t) => {
  const db = freshDb(t);
  const blob = mintState(KEY, samplePayload());

  const mid = Math.floor(blob.length / 2);
  const flipped = blob[mid] === 'A' ? 'B' : 'A';
  const tampered = blob.slice(0, mid) + flipped + blob.slice(mid + 1);
  assert.notEqual(tampered, blob, 'tampering actually changed the blob');

  assert.throws(
    () => verifyState(KEY, db, tampered, { principal: PRINCIPAL, argsDigest: canonicalArgsDigest(ARGS) }),
    expectCode('INTEGRITY')
  );
});

test('T2c: an expired state is rejected with EXPIRED', (t) => {
  const db = freshDb(t);
  const issuedAt = 1_700_000_000;
  const blob = mintState(KEY, samplePayload({ issuedAt, ttlSeconds: 90 }));

  assert.throws(
    () =>
      verifyState(KEY, db, blob, {
        principal: PRINCIPAL,
        argsDigest: canonicalArgsDigest(ARGS),
        now: issuedAt + 91
      }),
    expectCode('EXPIRED')
  );
});

test('T2d: a state presented by a different principal is rejected with PRINCIPAL', (t) => {
  const db = freshDb(t);
  const blob = mintState(KEY, samplePayload());

  assert.throws(
    () =>
      verifyState(KEY, db, blob, {
        principal: 'other-client:client-zzz999',
        argsDigest: canonicalArgsDigest(ARGS)
      }),
    expectCode('PRINCIPAL')
  );
});

test('T2e: a state replayed against different arguments is rejected with DIGEST', (t) => {
  const db = freshDb(t);
  const blob = mintState(KEY, samplePayload());

  assert.throws(
    () =>
      verifyState(KEY, db, blob, {
        principal: PRINCIPAL,
        argsDigest: canonicalArgsDigest({ query: 'weather in LA', units: 'metric' })
      }),
    expectCode('DIGEST')
  );
});

test('T2f: a replayed nonce is rejected with REPLAY on the second verify', (t) => {
  const db = freshDb(t);
  const blob = mintState(KEY, samplePayload());
  const expect = { principal: PRINCIPAL, argsDigest: canonicalArgsDigest(ARGS) };

  verifyState(KEY, db, blob, expect);

  assert.throws(() => verifyState(KEY, db, blob, expect), expectCode('REPLAY'));
});
