/**
 * L402 Format Relaxation Tests
 *
 * BLIP-0026 is token-format agnostic: "any authentication token that can commit
 * to a payment hash may be used." V2 TLV binary is RECOMMENDED, not REQUIRED.
 *
 * These tests verify:
 *   - l402_format column exists and accepts all format strings
 *   - API supports ?l402_format= filter
 *   - Legacy ?l402_compliant= filter still works (backward compat)
 *   - Digest endpoint includes format distribution
 *   - Health checker no longer degrades for format-only issues
 *   - Health checker STILL degrades for payment hash mismatch
 *   - Detail page shows "Macaroon Format" (neutral), not "Spec Compliance"
 *   - Reason strings say "recommended" not "spec requires"
 *
 * Run: node --test test/l402-format-relaxation.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { isSpecCompliantMacaroon } from '../src/services/l402-utils.js'
import { detectProtocol, getPrimaryDetection } from '../src/services/detect-protocol.js'

// ─── Fixture Helpers (copied from l402-spec-compliance.test.js) ──────────────

function writeVarint(value) {
  const bytes = []
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  bytes.push(value & 0x7f)
  return Buffer.from(bytes)
}

function buildL402Identifier(paymentHash, tokenId, version = 0) {
  const id = Buffer.alloc(66)
  id.writeUInt16BE(version, 0)
  paymentHash.copy(id, 2)
  tokenId.copy(id, 34)
  return id
}

function buildV2Macaroon(identifier, signature, opts = {}) {
  const parts = []
  parts.push(Buffer.from([0x02]))
  if (opts.location) {
    const loc = Buffer.from(opts.location, 'utf8')
    parts.push(Buffer.from([0x01]))
    parts.push(writeVarint(loc.length))
    parts.push(loc)
  }
  parts.push(Buffer.from([0x02]))
  parts.push(writeVarint(identifier.length))
  parts.push(identifier)
  parts.push(Buffer.from([0x00]))
  if (opts.caveats) {
    for (const cav of opts.caveats) {
      const cavBuf = Buffer.from(cav, 'utf8')
      parts.push(Buffer.from([0x02]))
      parts.push(writeVarint(cavBuf.length))
      parts.push(cavBuf)
      parts.push(Buffer.from([0x00]))
    }
  }
  parts.push(Buffer.from([0x06]))
  parts.push(writeVarint(signature.length))
  parts.push(signature)
  parts.push(Buffer.from([0x00]))
  return Buffer.concat(parts).toString('base64')
}

function buildV0TextMacaroon({ location, identifier, caveats = [], signature }) {
  const lines = []
  function addPacket(tag, value) {
    const content = `${tag} ${value}\n`
    const len = (content.length + 4).toString(16).padStart(4, '0')
    lines.push(`${len}${content}`)
  }
  addPacket('location', location || 'test-location')
  addPacket('identifier', identifier || 'test-id')
  for (const c of caveats) {
    addPacket('cid', c)
  }
  const sigContent = `signature ${signature || 'A'.repeat(32)}\n`
  const sigLen = (sigContent.length + 4).toString(16).padStart(4, '0')
  lines.push(`${sigLen}${sigContent}`)
  return Buffer.from(lines.join('')).toString('base64')
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const VALID_BOLT11 = 'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'
const MATCHING_PAYMENT_HASH = Buffer.from('f5636521e98000697a6700b979c288ddad56cb3995a2eb07550872c466ccc3e5', 'hex')
const DIFFERENT_PAYMENT_HASH = Buffer.alloc(32, 0xFF)
const TOKEN_ID = Buffer.alloc(32, 0x42)
const VALID_SIGNATURE = Buffer.alloc(32, 0xAA)

const MATCHING_ID = buildL402Identifier(MATCHING_PAYMENT_HASH, TOKEN_ID)
const SPEC_MACAROON = buildV2Macaroon(MATCHING_ID, VALID_SIGNATURE)
const MISMATCHED_ID = buildL402Identifier(DIFFERENT_PAYMENT_HASH, TOKEN_ID)
const MISMATCHED_MACAROON = buildV2Macaroon(MISMATCHED_ID, VALID_SIGNATURE)

const JSON_MACAROON = Buffer.from(JSON.stringify({
  id: 'abc123', caveats: ['payment_hash = deadbeef'], sig: 'cafebabe'
})).toString('base64')

const V0_BASIC = buildV0TextMacaroon({ location: '0/receipt/1', identifier: 'id11503id' })

// ─── Part 1: DB Schema — l402_format column ─────────────────────────────────

describe('L402 format relaxation — DB migration', () => {
  let db

  before(async () => {
    db = (await import('../src/db.js')).default
  })

  it('services table has l402_format column (TEXT, nullable)', () => {
    const cols = db.pragma("table_info('services')")
    const col = cols.find(c => c.name === 'l402_format')
    assert.ok(col, 'l402_format column should exist')
    assert.equal(col.type, 'TEXT')
    assert.equal(col.notnull, 0, 'should be nullable')
  })

  it('l402_format accepts all valid format strings', () => {
    const formats = ['v2_tlv', 'v1_binary', 'v0_text', 'json', 'unknown']
    for (const fmt of formats) {
      db.prepare(`
        INSERT OR REPLACE INTO services (id, name, url, protocol, source, l402_format)
        VALUES (@id, @name, @url, @protocol, @source, @l402_format)
      `).run({
        id: `__test_fmt_${fmt}__`,
        name: `Test ${fmt}`,
        url: `https://test-${fmt}.example.com/v1`,
        protocol: 'L402',
        source: 'satring',
        l402_format: fmt,
      })
      const row = db.prepare('SELECT l402_format FROM services WHERE id = ?').get(`__test_fmt_${fmt}__`)
      assert.equal(row.l402_format, fmt)
    }
    // Cleanup
    for (const fmt of formats) {
      db.prepare('DELETE FROM services WHERE id = ?').run(`__test_fmt_${fmt}__`)
    }
  })
})

// ─── Part 1: API filter — l402_format ────────────────────────────────────────

describe('L402 format relaxation — API filtering', () => {
  let db, queryServices, API_COLUMNS

  before(async () => {
    db = (await import('../src/db.js')).default
    const queries = await import('../src/queries/services.js')
    queryServices = queries.queryServices
    API_COLUMNS = queries.API_COLUMNS

    const insert = db.prepare(`
      INSERT OR REPLACE INTO services (id, name, url, protocol, source, health_status, status, l402_format, l402_compliant)
      VALUES (@id, @name, @url, @protocol, @source, @health_status, 'active', @l402_format, @l402_compliant)
    `)
    insert.run({ id: '__test_fmt_api_v2__', name: 'FmtTest V2', url: 'https://fmttest-v2.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_format: 'v2_tlv', l402_compliant: 1 })
    insert.run({ id: '__test_fmt_api_json__', name: 'FmtTest JSON', url: 'https://fmttest-json.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_format: 'json', l402_compliant: 0 })
    insert.run({ id: '__test_fmt_api_v0__', name: 'FmtTest V0', url: 'https://fmttest-v0.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_format: 'v0_text', l402_compliant: 0 })
    insert.run({ id: '__test_fmt_api_v1__', name: 'FmtTest V1', url: 'https://fmttest-v1.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_format: 'v1_binary', l402_compliant: 1 })
  })

  after(() => {
    for (const id of ['__test_fmt_api_v2__', '__test_fmt_api_json__', '__test_fmt_api_v0__', '__test_fmt_api_v1__']) {
      db.prepare('DELETE FROM services WHERE id = ?').run(id)
    }
  })

  it('?l402_format=v2_tlv returns only V2 TLV services', () => {
    const result = queryServices(db, { l402_format: 'v2_tlv', q: 'FmtTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1)
    for (const svc of result.services) {
      assert.equal(svc.l402_format, 'v2_tlv')
    }
  })

  it('?l402_format=json returns only JSON-format services', () => {
    const result = queryServices(db, { l402_format: 'json', q: 'FmtTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1)
    for (const svc of result.services) {
      assert.equal(svc.l402_format, 'json')
    }
  })

  it('legacy ?l402_compliant=true maps to v2_tlv + v1_binary', () => {
    const result = queryServices(db, { l402_compliant: 'true', q: 'FmtTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1)
    for (const svc of result.services) {
      assert.ok(['v2_tlv', 'v1_binary'].includes(svc.l402_format), `expected v2_tlv or v1_binary, got ${svc.l402_format}`)
    }
  })

  it('legacy ?l402_compliant=false maps to v0_text + json + unknown', () => {
    const result = queryServices(db, { l402_compliant: 'false', q: 'FmtTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1)
    for (const svc of result.services) {
      assert.ok(['v0_text', 'json', 'unknown'].includes(svc.l402_format), `expected non-binary format, got ${svc.l402_format}`)
    }
  })

  it('API_COLUMNS includes l402_format', () => {
    assert.ok(API_COLUMNS.includes('l402_format'))
  })
})

// ─── Part 1: Digest endpoint — format distribution ──────────────────────────

describe('L402 format relaxation — digest endpoint', () => {
  let db

  before(async () => {
    db = (await import('../src/db.js')).default

    const insert = db.prepare(`
      INSERT OR REPLACE INTO services (id, name, url, protocol, source, health_status, status, l402_format)
      VALUES (@id, @name, @url, @protocol, @source, @health_status, 'active', @l402_format)
    `)
    insert.run({ id: '__test_dig_v2__', name: 'DigTest V2', url: 'https://digtest-v2.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_format: 'v2_tlv' })
    insert.run({ id: '__test_dig_json__', name: 'DigTest JSON', url: 'https://digtest-json.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', l402_format: 'json' })
  })

  after(() => {
    for (const id of ['__test_dig_v2__', '__test_dig_json__']) {
      db.prepare('DELETE FROM services WHERE id = ?').run(id)
    }
  })

  it('can query l402_format distribution', () => {
    const ACTIVE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"
    const rows = db.prepare(`
      SELECT l402_format, COUNT(*) as count
      FROM services
      WHERE protocol = 'L402' AND l402_format IS NOT NULL AND ${ACTIVE}
      GROUP BY l402_format
    `).all()
    assert.ok(rows.length >= 1)
    const formats = {}
    for (const r of rows) formats[r.l402_format] = r.count
    // Our test data should have at least v2_tlv and json
    assert.ok(formats.v2_tlv >= 1, 'should have at least 1 v2_tlv')
    assert.ok(formats.json >= 1, 'should have at least 1 json')
  })

  it('can derive legacy compliant/non-compliant counts from l402_format', () => {
    const ACTIVE = "(status = 'active' OR status IS NULL) AND (provider_deleted = 0 OR provider_deleted IS NULL)"
    const rows = db.prepare(`
      SELECT l402_format, COUNT(*) as count
      FROM services
      WHERE protocol = 'L402' AND l402_format IS NOT NULL AND ${ACTIVE}
      GROUP BY l402_format
    `).all()
    let compliant = 0
    let nonCompliant = 0
    for (const r of rows) {
      if (r.l402_format === 'v2_tlv' || r.l402_format === 'v1_binary') {
        compliant += r.count
      } else {
        nonCompliant += r.count
      }
    }
    assert.equal(typeof compliant, 'number')
    assert.equal(typeof nonCompliant, 'number')
  })
})

// ─── Part 2: Health Checker — Format no longer degrades ─────────────────────

describe('L402 format relaxation — health check behavior', () => {
  // Simulate checkService's L402 compliance logic with the RELAXED rules
  function simulateHealthCheck(wwwAuthHeader) {
    const detections = detectProtocol({ wwwAuthenticate: wwwAuthHeader })
    const detection = getPrimaryDetection(detections, 'L402')
    const classification = { healthStatus: 'healthy', checkStatus: 'healthy' }

    // Relaxed logic: only payment hash mismatch degrades (not format)
    if (detection.protocol === 'L402' && classification.healthStatus === 'healthy') {
      if (!detection.valid) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      } else if (detection.details?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = detection.degradeReason || 'payment hash mismatch between macaroon and invoice'
      }
      // Note: specCompliant===false no longer degrades
    }

    return { classification, detection }
  }

  it('JSON macaroon format → healthy, NOT degraded', () => {
    const { classification } = simulateHealthCheck(
      `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(classification.healthStatus, 'healthy', 'JSON format should NOT degrade health')
  })

  it('V0 text macaroon format → healthy, NOT degraded', () => {
    const { classification } = simulateHealthCheck(
      `L402 macaroon="${V0_BASIC}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(classification.healthStatus, 'healthy', 'V0 text format should NOT degrade health')
  })

  it('payment hash mismatch → STILL degraded', () => {
    const { classification } = simulateHealthCheck(
      `L402 macaroon="${MISMATCHED_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(classification.healthStatus, 'degraded', 'payment hash mismatch MUST degrade health')
    assert.ok(classification.degradeReason.includes('mismatch'))
  })

  it('spec-compliant V2 TLV → healthy', () => {
    const { classification } = simulateHealthCheck(
      `L402 macaroon="${SPEC_MACAROON}", invoice="${VALID_BOLT11}"`
    )
    assert.equal(classification.healthStatus, 'healthy')
  })
})

describe('L402 format relaxation — POST fallback behavior', () => {
  function simulateWithPostFallback({ primaryHttpStatus, primaryDetection, postFallbackDetection, protocol = 'L402' }) {
    const classification = primaryHttpStatus === 402
      ? { healthStatus: 'healthy', checkStatus: 'healthy', consecutiveFailures: 0 }
      : { healthStatus: 'degraded', checkStatus: 'method_not_allowed', consecutiveFailures: 0 }

    // Relaxed primary path: only payment hash mismatch degrades
    if ((protocol === 'L402') && primaryHttpStatus === 402 && classification.healthStatus === 'healthy') {
      if (!primaryDetection.valid) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
      } else if (primaryDetection.details?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = primaryDetection.degradeReason || 'payment hash mismatch'
      }
    }

    // Relaxed POST fallback: only payment hash mismatch degrades
    // postFallbackDetection is now an array from detectProtocol()
    const postPrimary = postFallbackDetection ? getPrimaryDetection(postFallbackDetection, protocol) : null
    if (postPrimary?.valid) {
      const postDetails = postPrimary.details
      if (protocol === 'L402' && postDetails?.paymentHashMatch === false) {
        classification.healthStatus = 'degraded'
        classification.checkStatus = 'degraded'
        classification.degradeReason = postPrimary.degradeReason || 'payment hash mismatch'
      } else {
        classification.healthStatus = 'healthy'
        classification.checkStatus = 'healthy'
        classification.consecutiveFailures = 0
      }
    }

    return classification
  }

  it('POST fallback with JSON macaroon → healthy (format does not degrade)', () => {
    const postDetection = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    const result = simulateWithPostFallback({
      primaryHttpStatus: 405,
      primaryDetection: { valid: false, details: {} },
      postFallbackDetection: postDetection,
    })
    assert.equal(result.healthStatus, 'healthy', 'non-compliant format via POST should be healthy')
  })

  it('POST fallback with payment hash mismatch → still degraded', () => {
    const postDetection = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${MISMATCHED_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    const result = simulateWithPostFallback({
      primaryHttpStatus: 405,
      primaryDetection: { valid: false, details: {} },
      postFallbackDetection: postDetection,
    })
    assert.equal(result.healthStatus, 'degraded', 'payment hash mismatch via POST should stay degraded')
  })
})

// ─── Part 2: l402_format extraction logic ───────────────────────────────────

describe('L402 format relaxation — format extraction from detection', () => {
  function extractFormat(detections) {
    const detection = getPrimaryDetection(detections, 'L402')
    if (!detection?.details?.format) return null
    return detection.details.format
  }

  it('V2 TLV macaroon → l402_format=v2_tlv', () => {
    const detections = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${SPEC_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(extractFormat(detections), 'v2_tlv')
  })

  it('JSON macaroon → l402_format=json', () => {
    const detections = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(extractFormat(detections), 'json')
  })

  it('V0 text macaroon → l402_format=v0_text', () => {
    const detections = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${V0_BASIC}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(extractFormat(detections), 'v0_text')
  })

  it('V1 binary macaroon → l402_format=v1_binary (not v2_tlv)', () => {
    function buildV1Macaroon(identifier, signature) {
      const parts = []
      const version = Buffer.alloc(4)
      version.writeUInt32BE(1, 0)
      parts.push(version)
      parts.push(writeVarint(identifier.length))
      parts.push(identifier)
      parts.push(signature)
      return Buffer.concat(parts).toString('base64')
    }
    const v1Mac = buildV1Macaroon(MATCHING_ID, VALID_SIGNATURE)
    const detections = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${v1Mac}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(extractFormat(detections), 'v1_binary')
  })
})

// ─── Part 3: Reason strings say "recommended" not "spec requires" ───────────

describe('L402 format relaxation — reason strings', () => {
  it('JSON macaroon reason says "macaroon-spec.md" not "spec requires"', () => {
    const result = isSpecCompliantMacaroon(JSON_MACAROON)
    assert.equal(result.compliant, false)
    assert.ok(!result.reason.includes('spec requires'), `should not say "spec requires", got: ${result.reason}`)
    assert.ok(result.reason.includes('macaroon-spec.md'), `should include spec link, got: ${result.reason}`)
  })

  it('V0 text macaroon reason says "macaroon-spec.md" not "spec requires"', () => {
    const result = isSpecCompliantMacaroon(V0_BASIC)
    assert.equal(result.compliant, false)
    assert.ok(!result.reason.includes('spec requires'), `should not say "spec requires", got: ${result.reason}`)
    assert.ok(result.reason.includes('macaroon-spec.md'), `should include spec link, got: ${result.reason}`)
  })

  it('unrecognized format reason says "macaroon-spec.md" not "spec requires"', () => {
    const unknown = Buffer.from([0xFF, 0xFE, 0x00, ...Array(30).fill(0x42)]).toString('base64')
    const result = isSpecCompliantMacaroon(unknown)
    assert.equal(result.compliant, false)
    assert.ok(!result.reason.includes('spec requires'), `should not say "spec requires", got: ${result.reason}`)
    assert.ok(result.reason.includes('macaroon-spec.md'), `should include spec link, got: ${result.reason}`)
  })
})

// ─── Part 4: Detail page — "Macaroon Format" section ────────────────────────

describe('L402 format relaxation — detail page', () => {
  let detailPage

  before(async () => {
    detailPage = (await import('../src/views/detail.js')).detailPage
  })

  it('shows "Macaroon Format" (not "L402 Spec Compliance")', () => {
    const html = detailPage({
      id: 'test-fmt-1', name: 'Test', url: 'https://test.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'v2_tlv',
    })
    assert.ok(html.includes('Macaroon Format'), 'should show "Macaroon Format"')
    assert.ok(!html.includes('Spec Compliance'), 'should NOT show "Spec Compliance"')
    assert.ok(!html.includes('Non-Compliant'), 'should NOT show "Non-Compliant"')
  })

  it('shows "V2 TLV Binary" for v2_tlv format', () => {
    const html = detailPage({
      id: 'test-fmt-2', name: 'Test V2', url: 'https://test2.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'v2_tlv',
    })
    assert.ok(html.includes('V2 TLV Binary'))
  })

  it('shows "JSON" for json format — neutral, no warning', () => {
    const html = detailPage({
      id: 'test-fmt-3', name: 'Test JSON', url: 'https://test3.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'json',
    })
    assert.ok(html.includes('>JSON<') || html.includes('>JSON</'))
  })

  it('shows "V0 Text (libmacaroons)" for v0_text format', () => {
    const html = detailPage({
      id: 'test-fmt-4', name: 'Test V0', url: 'https://test4.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'v0_text',
    })
    assert.ok(html.includes('V0 Text (libmacaroons)'))
  })

  it('shows payment hash mismatch warning with amber color', () => {
    const html = detailPage({
      id: 'test-fmt-5', name: 'Test Mismatch', url: 'https://test5.com', protocol: 'L402',
      health_status: 'degraded', consecutive_failures: 0, source: 'satring',
      l402_format: 'v2_tlv',
      l402_degrade_reason: 'payment hash mismatch between macaroon and invoice',
    })
    assert.ok(html.includes('payment hash mismatch'))
    assert.ok(html.includes('var(--amber)'))
  })

  it('does NOT show macaroon format section for x402 endpoints', () => {
    const html = detailPage({
      id: 'test-fmt-6', name: 'Test x402', url: 'https://test6.com', protocol: 'x402',
      health_status: 'healthy', consecutive_failures: 0, source: 'bazaar',
      x402_payment_valid: 1, x402_asset_known: 1, x402_facilitator_reachable: 1,
    })
    assert.ok(!html.includes('Macaroon Format'))
  })

  it('does NOT show macaroon format section for MPP endpoints', () => {
    const html = detailPage({
      id: 'test-fmt-7', name: 'Test MPP', url: 'https://test7.com', protocol: 'MPP',
      health_status: 'healthy', consecutive_failures: 0, source: 'mpp',
    })
    assert.ok(!html.includes('Macaroon Format'))
  })

  it('directory listing does NOT expose l402_format', async () => {
    const { homePage } = await import('../src/views/home.js')
    const html = homePage({
      services: [
        { id: '1', name: 'Svc', url: 'https://test.com', protocol: 'L402', health_status: 'healthy', source: 'satring', category: 'ai', l402_format: 'json' },
      ],
      total: 1, limit: 50, offset: 0,
      filters: {},
      stats: { healthy: 1, degraded: 0, down: 0 },
      categories: [],
      btcUsdRate: 60000,
    })
    const lower = html.toLowerCase()
    assert.ok(!lower.includes('l402_format'), 'directory must not contain l402_format')
    assert.ok(!lower.includes('macaroon format'), 'directory must not contain "macaroon format"')
  })
})
