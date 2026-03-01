import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { flagTemplates, flagDemos, classifyServices } from '../src/services/classify.js'

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      protocol TEXT NOT NULL,
      price_sats INTEGER,
      price_usd REAL,
      payment_asset TEXT,
      payment_network TEXT,
      category TEXT,
      input_schema TEXT,
      output_schema TEXT,
      provider TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      featured INTEGER DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      health_status TEXT DEFAULT 'unknown',
      uptime_30d REAL,
      latency_p50_ms INTEGER,
      last_checked TEXT,
      last_seen_healthy TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      is_template INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0
    )
  `)
  return db
}

function insertService(db, id, url, opts = {}) {
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, opts.name || id, url, opts.protocol || 'x402', opts.source || 'bazaar')
}

describe('flagTemplates', () => {
  it('flags services when 5+ distinct hostnames share the same pathname', () => {
    const db = createTestDb()
    // 5 different hosts, same path
    for (let i = 0; i < 5; i++) {
      insertService(db, `tmpl-${i}`, `https://host${i}.example.com/x402-starter/api`)
    }
    // Unrelated service
    insertService(db, 'unique', 'https://unique.example.com/my-api')

    const count = flagTemplates(db)
    assert.equal(count, 5)
    assert.equal(db.prepare('SELECT is_template FROM services WHERE id = ?').get('tmpl-0').is_template, 1)
    assert.equal(db.prepare('SELECT is_template FROM services WHERE id = ?').get('unique').is_template, 0)
  })

  it('does NOT flag when fewer than 5 distinct hostnames share pathname', () => {
    const db = createTestDb()
    for (let i = 0; i < 4; i++) {
      insertService(db, `few-${i}`, `https://host${i}.example.com/starter/api`)
    }

    const count = flagTemplates(db)
    assert.equal(count, 0)
    for (let i = 0; i < 4; i++) {
      assert.equal(db.prepare('SELECT is_template FROM services WHERE id = ?').get(`few-${i}`).is_template, 0)
    }
  })

  it('does NOT flag root pathname "/" even with 5+ distinct hosts', () => {
    const db = createTestDb()
    for (let i = 0; i < 10; i++) {
      insertService(db, `root-${i}`, `https://provider${i}.com/`)
    }

    const count = flagTemplates(db)
    assert.equal(count, 0)
    for (let i = 0; i < 10; i++) {
      assert.equal(db.prepare('SELECT is_template FROM services WHERE id = ?').get(`root-${i}`).is_template, 0)
    }
  })

  it('handles invalid URLs gracefully', () => {
    const db = createTestDb()
    insertService(db, 'bad', 'not-a-url')
    const count = flagTemplates(db)
    assert.equal(count, 0)
  })
})

describe('flagDemos', () => {
  it('flags "demo.example.com"', () => {
    const db = createTestDb()
    insertService(db, 'd1', 'https://demo.example.com/api')

    const count = flagDemos(db)
    assert.equal(count, 1)
    assert.equal(db.prepare('SELECT is_demo FROM services WHERE id = ?').get('d1').is_demo, 1)
  })

  it('flags "my-demo-app.vercel.app"', () => {
    const db = createTestDb()
    insertService(db, 'd2', 'https://my-demo-app.vercel.app/api')

    const count = flagDemos(db)
    assert.equal(count, 1)
  })

  it('does NOT flag "contest.mysite.com" (no exact segment match)', () => {
    const db = createTestDb()
    insertService(db, 'c1', 'https://contest.mysite.com/api')

    const count = flagDemos(db)
    assert.equal(count, 0)
    assert.equal(db.prepare('SELECT is_demo FROM services WHERE id = ?').get('c1').is_demo, 0)
  })

  it('flags hostname segments: test, example, starter, tutorial, hello, sample, placeholder', () => {
    const db = createTestDb()
    const keywords = ['test', 'example', 'starter', 'tutorial', 'hello', 'sample', 'placeholder']
    for (const kw of keywords) {
      insertService(db, kw, `https://${kw}.mysite.com/api`)
    }

    const count = flagDemos(db)
    assert.equal(count, keywords.length)
  })

  it('handles invalid URLs gracefully', () => {
    const db = createTestDb()
    insertService(db, 'bad', 'not-a-url')
    const count = flagDemos(db)
    assert.equal(count, 0)
  })
})

describe('classifyServices', () => {
  it('resets flags before re-classifying', () => {
    const db = createTestDb()
    insertService(db, 's1', 'https://demo.mysite.com/api')
    insertService(db, 's2', 'https://production.mysite.com/api')

    classifyServices(db)
    assert.equal(db.prepare('SELECT is_demo FROM services WHERE id = ?').get('s1').is_demo, 1)

    // Change s1 URL to non-demo, re-classify — should reset
    db.prepare("UPDATE services SET url = 'https://production2.mysite.com/api' WHERE id = 's1'").run()
    classifyServices(db)
    assert.equal(db.prepare('SELECT is_demo FROM services WHERE id = ?').get('s1').is_demo, 0)
  })

  it('counts match expectations', () => {
    const db = createTestDb()
    insertService(db, 'demo1', 'https://demo.mysite.com/api')
    for (let i = 0; i < 5; i++) {
      insertService(db, `tmpl-${i}`, `https://host${i}.mysite.com/template-path/api`)
    }
    insertService(db, 'prod', 'https://real-service.com/api')

    classifyServices(db)

    const templates = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_template = 1').get().c
    const demos = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_demo = 1').get().c
    assert.equal(templates, 5)
    assert.equal(demos, 1)
  })
})
