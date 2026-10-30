import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../src/db.js'
import { loadListings } from '../src/listings.js'

test('curated YAML upgrades a pending POST listing without losing its probe body', () => {
  const url = 'https://api.aomi.dev/v1/task/build'
  db.prepare(`
    INSERT INTO services (id, name, url, protocol, source, status, http_method)
    VALUES (?, ?, ?, 'x402', 'self-registered', 'pending', 'GET')
  `).run('pending-aomi-task', 'Pending Aomi Task', url)

  loadListings()

  const listing = db.prepare(`
    SELECT id, source, source_id, status, http_method, probe_body
    FROM services WHERE url = ? AND protocol = 'x402'
  `).get(url)
  assert.equal(listing.id, 'pending-aomi-task')
  assert.equal(listing.source, 'exclusive')
  assert.equal(listing.source_id, 'aomi-task-api.yaml')
  assert.equal(listing.status, 'active')
  assert.equal(listing.http_method, 'POST')
  const body = JSON.parse(listing.probe_body)
  assert.equal(body.chainId, 5042)
  assert.equal(typeof body.chainId, 'number')
})
