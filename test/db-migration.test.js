import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'

describe('DB migrations', () => {
  it('are idempotent — new columns exist after init', () => {
    const cols = db.pragma("table_info('services')").map(c => c.name)

    // bLIP-0026 columns
    assert.ok(cols.includes('l402_version'), 'missing l402_version')
    assert.ok(cols.includes('agent_spec_url'), 'missing agent_spec_url')
    assert.ok(cols.includes('capabilities'), 'missing capabilities')

    // L402 v2 metadata
    assert.ok(cols.includes('token_format'), 'missing token_format')
    assert.ok(cols.includes('invoice_type'), 'missing invoice_type')
    assert.ok(cols.includes('pricing_model'), 'missing pricing_model')

    // Content domain
    assert.ok(cols.includes('content_domain'), 'missing content_domain')
  })

  it('re-running ALTER TABLE for existing columns does not throw', () => {
    // Simulates what happens on second server start
    for (const col of ['l402_version', 'agent_spec_url', 'capabilities',
                       'token_format', 'invoice_type', 'pricing_model', 'content_domain']) {
      assert.doesNotThrow(() => {
        try {
          db.exec(`ALTER TABLE services ADD COLUMN ${col} TEXT`)
        } catch {
          // expected — column already exists
        }
      })
    }
  })
})
