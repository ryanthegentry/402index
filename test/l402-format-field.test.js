/**
 * L402 Format Field Tests
 *
 * Tests cover:
 *   isSpecCompliantMacaroon — format field on all macaroon types
 *   validateL402Challenge   — format passthrough to result
 *   detectProtocol          — format in details object
 *   Format extraction       — details.format used directly (V1/V2 disambiguation)
 *   DB schema               — lnget_compatible column exists
 *   API filtering           — ?lnget_compatible query parameter
 *   Detail page             — lnget compatibility display
 *   OpenAPI spec            — l402_format + lnget_compatible in schema/params
 *   Bazaar source link      — correct URL
 *
 * Run: node --test test/l402-format-field.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { isSpecCompliantMacaroon, validateL402Challenge } from '../src/services/l402-utils.js'
import { detectProtocol } from '../src/services/detect-protocol.js'
import { sourceLink } from '../src/views/helpers.js'
import { openapiSpec } from '../src/openapi.js'

// ─── Fixture Helpers ─────────────────────────────────────────────────────────

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
const SPEC_MACAROON = buildV2Macaroon(MATCHING_ID, VALID_SIGNATURE) // V2 TLV
const V1_VALID_MACAROON = buildV1Macaroon(MATCHING_ID, VALID_SIGNATURE) // V1 binary
const JSON_MACAROON = Buffer.from(JSON.stringify({ id: 'abc123', caveats: ['payment_hash = deadbeef'], sig: 'cafebabe' })).toString('base64')
const V0_BASIC = buildV0TextMacaroon({ location: '0/receipt/1', identifier: 'id11503id' })
const TRULY_UNKNOWN_MACAROON = Buffer.from([0xFF, 0xFE, 0x00, ...Array(30).fill(0x42)]).toString('base64')

// ─── Group 1: isSpecCompliantMacaroon format field ───────────────────────────

describe('isSpecCompliantMacaroon — format field (Part 1)', () => {
  it('V2 TLV macaroon returns format=v2_tlv and compliant=true', () => {
    const result = isSpecCompliantMacaroon(SPEC_MACAROON)
    assert.equal(result.format, 'v2_tlv')
    assert.equal(result.compliant, true)
  })

  it('V1 binary macaroon returns format=v1_binary and compliant=true', () => {
    const result = isSpecCompliantMacaroon(V1_VALID_MACAROON)
    assert.equal(result.format, 'v1_binary')
    assert.equal(result.compliant, true)
  })

  it('JSON macaroon returns format=json and compliant=false', () => {
    const result = isSpecCompliantMacaroon(JSON_MACAROON)
    assert.equal(result.format, 'json')
    assert.equal(result.compliant, false)
  })

  it('V0 text macaroon returns format=v0_text and compliant=false', () => {
    const result = isSpecCompliantMacaroon(V0_BASIC)
    assert.equal(result.format, 'v0_text')
    assert.equal(result.compliant, false)
  })

  it('unknown format (0xFF start) returns format=unknown and compliant=false', () => {
    const result = isSpecCompliantMacaroon(TRULY_UNKNOWN_MACAROON)
    assert.equal(result.format, 'unknown')
    assert.equal(result.compliant, false)
  })

  it('empty string returns compliant=false and format=undefined', () => {
    const result = isSpecCompliantMacaroon('')
    assert.equal(result.compliant, false)
    assert.equal(result.format, undefined)
  })

  it('null input returns compliant=false and format=undefined', () => {
    const result = isSpecCompliantMacaroon(null)
    assert.equal(result.compliant, false)
    assert.equal(result.format, undefined)
  })
})

// ─── Group 2: validateL402Challenge format passthrough ───────────────────────

describe('validateL402Challenge — format passthrough', () => {
  it('JSON macaroon + valid invoice passes through format=json', () => {
    const result = validateL402Challenge(JSON_MACAROON, VALID_BOLT11)
    assert.equal(result.format, 'json')
  })

  it('V2 TLV macaroon + valid invoice passes through format=v2_tlv', () => {
    const result = validateL402Challenge(SPEC_MACAROON, VALID_BOLT11)
    assert.equal(result.format, 'v2_tlv')
  })

  it('V1 binary macaroon + valid invoice passes through format=v1_binary', () => {
    const result = validateL402Challenge(V1_VALID_MACAROON, VALID_BOLT11)
    assert.equal(result.format, 'v1_binary')
  })
})

// ─── Group 3: detectProtocol format in details ───────────────────────────────

describe('detectProtocol — format in details', () => {
  it('JSON macaroon in WWW-Authenticate returns details.format=json', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].details.format, 'json')
  })

  it('V2 TLV macaroon returns details.format=v2_tlv', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${SPEC_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].details.format, 'v2_tlv')
  })

  it('V1 binary macaroon returns details.format=v1_binary', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${V1_VALID_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].details.format, 'v1_binary')
  })
})

// ─── Group 4: Format extraction uses details.format directly (Part 2) ────────

describe('Format extraction uses details.format directly (Part 2)', () => {
  it('detection with details.format=json extracts format as json', () => {
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${JSON_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    // The format should be taken directly from details.format
    const extractedFormat = result[0].details.format
    assert.equal(extractedFormat, 'json')
  })

  it('detection with details.format=v1_binary and specCompliant=true extracts v1_binary NOT v2_tlv', () => {
    // This tests the V1/V2 disambiguation bug fix:
    // When a V1 binary macaroon is spec-compliant, the extracted format
    // must be 'v1_binary', not incorrectly mapped to 'v2_tlv'
    const result = detectProtocol({
      wwwAuthenticate: `L402 macaroon="${V1_VALID_MACAROON}", invoice="${VALID_BOLT11}"`,
    })
    assert.equal(result[0].details.specCompliant, true, 'V1 binary should be spec-compliant')
    assert.equal(result[0].details.format, 'v1_binary', 'format should be v1_binary, not v2_tlv')
    assert.notEqual(result[0].details.format, 'v2_tlv', 'must NOT incorrectly report as v2_tlv')
  })
})

// ─── Group 5: DB schema (Part 4) ────────────────────────────────────────────

describe('DB schema — lnget_compatible column (Part 4)', () => {
  let db

  before(async () => {
    db = (await import('../src/db.js')).default
  })

  it('lnget_compatible column exists in services table', () => {
    const cols = db.pragma("table_info('services')")
    const col = cols.find(c => c.name === 'lnget_compatible')
    assert.ok(col, 'lnget_compatible column should exist')
  })
})

// ─── Group 6: lnget_compatible API filtering ─────────────────────────────────

describe('lnget_compatible API filtering', () => {
  let db, queryServices, API_COLUMNS

  before(async () => {
    db = (await import('../src/db.js')).default
    const queries = await import('../src/queries/services.js')
    queryServices = queries.queryServices
    API_COLUMNS = queries.API_COLUMNS

    const insert = db.prepare(`
      INSERT OR REPLACE INTO services (id, name, url, protocol, source, health_status, status, lnget_compatible, l402_format)
      VALUES (@id, @name, @url, @protocol, @source, @health_status, 'active', @lnget_compatible, @l402_format)
    `)

    insert.run({ id: '__test_lnget_yes__', name: 'LngetTest Compatible', url: 'https://lnget-yes.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', lnget_compatible: 1, l402_format: 'v2_tlv' })
    insert.run({ id: '__test_lnget_no__', name: 'LngetTest Incompatible', url: 'https://lnget-no.example.com/v1', protocol: 'L402', source: 'satring', health_status: 'healthy', lnget_compatible: 0, l402_format: 'json' })
  })

  after(() => {
    for (const id of ['__test_lnget_yes__', '__test_lnget_no__']) {
      db.prepare('DELETE FROM health_checks WHERE service_id = ?').run(id)
      db.prepare('DELETE FROM services WHERE id = ?').run(id)
    }
  })

  it('?lnget_compatible=true returns only endpoints with lnget_compatible=1', () => {
    const result = queryServices(db, { lnget_compatible: 'true', q: 'LngetTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1, 'should return at least one result')
    for (const svc of result.services) {
      assert.equal(svc.lnget_compatible, 1)
    }
    // Should not include the incompatible one
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('__test_lnget_no__'), 'should not include incompatible endpoint')
  })

  it('?lnget_compatible=false returns only endpoints with lnget_compatible=0', () => {
    const result = queryServices(db, { lnget_compatible: 'false', q: 'LngetTest' }, API_COLUMNS)
    assert.ok(result.services.length >= 1, 'should return at least one result')
    for (const svc of result.services) {
      assert.equal(svc.lnget_compatible, 0)
    }
    // Should not include the compatible one
    const ids = result.services.map(s => s.id)
    assert.ok(!ids.includes('__test_lnget_yes__'), 'should not include compatible endpoint')
  })
})

// ─── Group 7: Detail page lnget compatibility (Part 4) ───────────────────────

describe('Detail page — lnget compatibility display (Part 4)', () => {
  let detailPage

  before(async () => {
    detailPage = (await import('../src/views/detail.js')).detailPage
  })

  it('V2 TLV endpoint shows lnget Compatible with Yes', () => {
    const html = detailPage({
      id: 'test-lnget-1', name: 'Test V2 TLV', url: 'https://test-v2.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'v2_tlv', lnget_compatible: 1,
    })
    assert.ok(html.includes('lnget Compatible'), 'should show lnget Compatible label')
    assert.ok(html.includes('Yes'), 'should show Yes for compatible endpoint')
  })

  it('JSON endpoint shows lnget Compatible with No', () => {
    const html = detailPage({
      id: 'test-lnget-2', name: 'Test JSON', url: 'https://test-json.com', protocol: 'L402',
      health_status: 'healthy', consecutive_failures: 0, source: 'satring',
      l402_format: 'json', lnget_compatible: 0,
    })
    assert.ok(html.includes('lnget Compatible'), 'should show lnget Compatible label')
    assert.ok(html.includes('No'), 'should show No for incompatible endpoint')
  })

  it('x402 endpoint does NOT show lnget Compatible', () => {
    const html = detailPage({
      id: 'test-lnget-3', name: 'Test x402', url: 'https://test-x402.com', protocol: 'x402',
      health_status: 'healthy', consecutive_failures: 0, source: 'bazaar',
      x402_payment_valid: 1, x402_asset_known: 1, x402_facilitator_reachable: 1,
    })
    assert.ok(!html.includes('lnget Compatible'), 'x402 endpoint should not show lnget Compatible')
  })
})

// ─── Group 8: OpenAPI spec (Part 6) ──────────────────────────────────────────

describe('OpenAPI spec — l402_format and lnget_compatible (Part 6)', () => {
  it('Service schema has l402_format property', () => {
    const serviceSchema = openapiSpec.components.schemas.Service
    assert.ok(serviceSchema.properties.l402_format, 'Service schema should have l402_format property')
  })

  it('Service schema has lnget_compatible property', () => {
    const serviceSchema = openapiSpec.components.schemas.Service
    assert.ok(serviceSchema.properties.lnget_compatible, 'Service schema should have lnget_compatible property')
  })

  it('GET /api/v1/services parameters include l402_format', () => {
    const params = openapiSpec.paths['/api/v1/services'].get.parameters
    const l402FormatParam = params.find(p => p.name === 'l402_format')
    assert.ok(l402FormatParam, 'should have l402_format query parameter')
    assert.equal(l402FormatParam.in, 'query')
  })

  it('GET /api/v1/services parameters include lnget_compatible', () => {
    const params = openapiSpec.paths['/api/v1/services'].get.parameters
    const lngetParam = params.find(p => p.name === 'lnget_compatible')
    assert.ok(lngetParam, 'should have lnget_compatible query parameter')
    assert.equal(lngetParam.in, 'query')
  })
})

// ─── Group 9: Bazaar source link ─────────────────────────────────────────────

describe('Bazaar source link', () => {
  it('sourceLink(bazaar) contains href="https://x402.org" (not /bazaar)', () => {
    const link = sourceLink('bazaar')
    assert.ok(link.includes('href="https://x402.org"'), `expected href to x402.org, got: ${link}`)
  })
})
