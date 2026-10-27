/**
 * Uptime bucket semantics, pinned per status (#313 Part A.2).
 *
 * Every status in HEALTH_CHECK_STATUSES belongs to exactly one bucket:
 *  - up   (numerator + denominator): healthy, degraded
 *  - down (denominator only):        down, timeout, error, method_not_allowed, not_acceptable
 *  - excluded (neither):             rate_limited
 *
 * BEHAVIOR-CHANGE: a 429 means the provider throttled our prober. It carries no availability
 * information, so it must not score a popular provider as down.
 *
 * Run: node --test test/health-uptime-buckets.test.js
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as dbModule from '../src/db.js'
import * as checker from '../src/health/checker.js'

const db = dbModule.default
const { HEALTH_CHECK_STATUSES } = dbModule

const TEST_PREFIX = 'test-uptime-' + Date.now()
let counter = 0

function seedService() {
  const id = `${TEST_PREFIX}-${++counter}`
  db.prepare(
    "INSERT INTO services (id, name, url, protocol, source) VALUES (?, 'Uptime Test', ?, 'L402', 'test')"
  ).run(id, `https://${id}.example.com/api`)
  return id
}

function addCheck(serviceId, status) {
  db.prepare('INSERT INTO health_checks (service_id, status) VALUES (?, ?)').run(serviceId, status)
}

afterEach(() => {
  db.prepare(`DELETE FROM health_checks WHERE service_id LIKE '${TEST_PREFIX}%'`).run()
  db.prepare(`DELETE FROM services WHERE id LIKE '${TEST_PREFIX}%'`).run()
})

describe('uptime buckets partition the status enum', () => {
  it('exports the three buckets', () => {
    assert.ok(Array.isArray(checker.UPTIME_UP_STATUSES), 'checker must export UPTIME_UP_STATUSES')
    assert.ok(Array.isArray(checker.UPTIME_DOWN_STATUSES), 'checker must export UPTIME_DOWN_STATUSES')
    assert.ok(Array.isArray(checker.UPTIME_EXCLUDED_STATUSES), 'checker must export UPTIME_EXCLUDED_STATUSES')
  })

  it('covers every canonical status exactly once', () => {
    const all = [
      ...checker.UPTIME_UP_STATUSES,
      ...checker.UPTIME_DOWN_STATUSES,
      ...checker.UPTIME_EXCLUDED_STATUSES,
    ]
    assert.equal(new Set(all).size, all.length, 'no status may appear in two buckets')
    assert.deepEqual([...all].sort(), [...HEALTH_CHECK_STATUSES].sort())
  })

  it('pins the membership of each bucket', () => {
    assert.deepEqual([...checker.UPTIME_UP_STATUSES].sort(), ['degraded', 'healthy'])
    assert.deepEqual(
      [...checker.UPTIME_DOWN_STATUSES].sort(),
      ['down', 'error', 'method_not_allowed', 'not_acceptable', 'timeout']
    )
    assert.deepEqual([...checker.UPTIME_EXCLUDED_STATUSES], ['rate_limited'])
  })
})

describe('calculateUptime per status', () => {
  for (const status of ['healthy', 'degraded']) {
    it(`counts ${status} in the numerator`, () => {
      const id = seedService()
      addCheck(id, status)
      assert.equal(checker.calculateUptime(id), 1)
    })
  }

  for (const status of ['down', 'timeout', 'error', 'method_not_allowed', 'not_acceptable']) {
    it(`counts ${status} in the denominator only`, () => {
      const id = seedService()
      addCheck(id, status)
      assert.equal(checker.calculateUptime(id), 0)
    })
  }

  it('excludes rate_limited from both numerator and denominator', () => {
    const id = seedService()
    addCheck(id, 'rate_limited')
    assert.equal(checker.calculateUptime(id), null, 'a throttled prober yields no uptime signal at all')
  })

  it('a throttled provider that answered once is 100%, not 50%', () => {
    const id = seedService()
    addCheck(id, 'healthy')
    addCheck(id, 'rate_limited')
    assert.equal(checker.calculateUptime(id), 1)
  })

  it('mixes up and down statuses across the window', () => {
    const id = seedService()
    addCheck(id, 'healthy')
    addCheck(id, 'healthy')
    addCheck(id, 'not_acceptable')
    addCheck(id, 'rate_limited')
    assert.equal(checker.calculateUptime(id), 0.6667)
  })

  it('returns null with no checks at all', () => {
    assert.equal(checker.calculateUptime(seedService()), null)
  })
})
