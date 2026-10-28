import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import db from '../src/db.js'
import { pollBazaar } from '../src/aggregators/bazaar.js'
import { RETIRE_AFTER } from '../src/aggregators/bazaar-presence.js'
import { registerUpsert } from '../src/services/service-registration.js'

const endpoint = n => `https://registration-retention-${n}.example.com/api`
const item = n => ({
  resource: endpoint(n),
  accepts: [{ resource: endpoint(n), maxAmountRequired: '10000', network: 'base', description: `Retention ${n}` }],
})
const row = n => db.prepare('SELECT * FROM services WHERE url = ?').get(endpoint(n))
let originalFetch

function cleanup() {
  db.prepare("DELETE FROM services WHERE url LIKE 'https://registration-retention-%'").run()
  db.prepare("DELETE FROM sync_state WHERE key IN ('bazaar_offset', 'bazaar_last_full_pass', 'bazaar_pass_id')").run()
  db.prepare('DELETE FROM bazaar_passes').run()
}

async function listOnly(...numbers) {
  const items = numbers.map(item)
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ pagination: { total: items.length }, items }),
  })
  await pollBazaar()
}

function register(n) {
  return registerUpsert().get({
    id: randomUUID(),
    name: `Provider registration ${n}`,
    description: 'A currently reachable provider endpoint',
    url: endpoint(n),
    protocol: 'x402',
    price_sats: null,
    price_usd: 0.01,
    payment_asset: 'USDC',
    payment_network: 'Base',
    category: 'tools',
    provider: 'Retention test provider',
    contact_email: null,
    http_method: 'POST',
    probe_body: '{}',
    hostname: new URL(endpoint(n)).hostname,
  })
}

beforeEach(() => { originalFetch = globalThis.fetch; cleanup() })
afterEach(() => { globalThis.fetch = originalFetch; cleanup() })

describe('Explicit registration survives unrelated Bazaar churn', () => {
  it('keeps a refreshed imported endpoint visible while retiring an unregistered counterpart', async () => {
    await listOnly(1, 2, 3)
    for (let i = 0; i < RETIRE_AFTER - 1; i++) await listOnly(1)
    assert.equal(row(2).status, 'active', 'the endpoint has not reached retirement yet')

    const refreshed = register(2)
    assert.equal(refreshed.status, 'active', 'registration preserves existing approval')

    await listOnly(1)
    assert.equal(row(2).status, 'active', 'a fresh provider registration must survive the next Bazaar pass')
    assert.equal(row(3).status, 'retired', 'normal retirement still applies to the unregistered endpoint')

    for (let i = 0; i < RETIRE_AFTER; i++) await listOnly(1)
    assert.equal(row(2).status, 'active', 'continued upstream absence must not undo explicit registration')
  })

  it('does not retire a re-registered and approved endpoint again on the following pass', async () => {
    await listOnly(1, 2)
    for (let i = 0; i < RETIRE_AFTER; i++) await listOnly(1)
    assert.equal(row(2).status, 'retired')

    const restored = register(2)
    assert.equal(restored.status, 'pending', 're-registration must retain the existing approval gate')
    // The route approves a successful registration for a verified domain.
    db.prepare("UPDATE services SET status = 'active', domain_verified = 1, approval_reason = 'domain-verified' WHERE id = ?").run(restored.id)

    await listOnly(1)
    assert.equal(row(2).status, 'active', 'the next Bazaar pass must not hide the approved endpoint again')
  })

  it('preserves curated listing provenance when refreshing an existing endpoint', async () => {
    const initial = register(2)
    db.prepare("UPDATE services SET source = 'exclusive', status = 'active' WHERE id = ?").run(initial.id)

    const refreshed = register(2)
    assert.equal(refreshed.source, 'exclusive', 'unrelated listing provenance must not change')
    assert.equal(refreshed.status, 'active')
  })
})
