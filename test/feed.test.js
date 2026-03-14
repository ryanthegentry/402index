import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { feedXml, rfcDate } from '../src/views/feed.js'

const SAMPLE_SERVICE = {
  id: 'abc-123',
  name: 'Test API',
  description: 'A test API for weather data',
  url: 'https://api.example.com/weather',
  protocol: 'L402',
  price_sats: 100,
  price_usd: 0.08,
  category: 'data/weather',
  health_status: 'healthy',
  reliability_score: 0.94,
  http_method: 'GET',
  registered_at: '2026-03-10T12:00:00.000Z',
}

const SAMPLE_SERVICE_X402 = {
  id: 'def-456',
  name: 'Image Generator',
  description: 'AI image generation endpoint',
  url: 'https://api.example.com/generate',
  protocol: 'x402',
  price_sats: 500,
  price_usd: 0.40,
  category: 'ai/image',
  health_status: 'degraded',
  reliability_score: 0.72,
  http_method: 'POST',
  registered_at: '2026-03-08T08:30:00.000Z',
}

describe('rfcDate', () => {
  it('converts ISO date string to RFC 2822 format', () => {
    const result = rfcDate('2026-03-10T12:00:00.000Z')
    // RFC 2822 format: "Tue, 10 Mar 2026 12:00:00 GMT"
    assert.ok(result.includes('10 Mar 2026'), `Expected RFC 2822 date, got: ${result}`)
    assert.ok(result.includes('12:00:00'), `Expected time in date, got: ${result}`)
  })

  it('handles Date objects', () => {
    const result = rfcDate(new Date('2026-01-15T00:00:00Z'))
    assert.ok(result.includes('15 Jan 2026'), `Expected RFC 2822 date, got: ${result}`)
  })

  it('returns empty string for null/undefined', () => {
    assert.equal(rfcDate(null), '')
    assert.equal(rfcDate(undefined), '')
  })
})

describe('feedXml', () => {
  it('returns valid XML with RSS 2.0 declaration', () => {
    const xml = feedXml({ services: [], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'Should start with XML declaration')
    assert.ok(xml.includes('<rss version="2.0"'), 'Should include RSS 2.0 tag')
    assert.ok(xml.includes('</rss>'), 'Should close RSS tag')
  })

  it('includes channel with title, link, description', () => {
    const xml = feedXml({ services: [], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<channel>'), 'Should include channel tag')
    assert.ok(xml.includes('<title>'), 'Should include title')
    assert.ok(xml.includes('<link>https://402index.io</link>'), 'Should include site link')
    assert.ok(xml.includes('<description>'), 'Should include description')
    assert.ok(xml.includes('<language>en</language>'), 'Should include language')
  })

  it('includes atom:link self reference', () => {
    const selfUrl = 'https://402index.io/feed.xml?protocol=L402'
    const xml = feedXml({ services: [], selfUrl, filters: {} })
    assert.ok(xml.includes(`<atom:link href="${selfUrl}" rel="self" type="application/rss+xml"/>`),
      'Should include atom:link self')
  })

  it('includes l402 namespace declaration', () => {
    const xml = feedXml({ services: [], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('xmlns:l402="https://402index.io/ns/l402"'), 'Should declare l402 namespace')
    assert.ok(xml.includes('xmlns:atom="http://www.w3.org/2005/Atom"'), 'Should declare atom namespace')
  })

  it('includes lastBuildDate in RFC 2822 format', () => {
    const xml = feedXml({ services: [], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<lastBuildDate>'), 'Should include lastBuildDate')
  })

  it('renders empty feed with no items', () => {
    const xml = feedXml({ services: [], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(!xml.includes('<item>'), 'Empty feed should have no items')
    assert.ok(xml.includes('</channel>'), 'Should still close channel')
  })

  it('renders service as item with title, link, guid, pubDate', () => {
    const xml = feedXml({ services: [SAMPLE_SERVICE], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<item>'), 'Should include item tag')
    assert.ok(xml.includes('<title>Test API</title>'), 'Item should have title')
    assert.ok(xml.includes('<link>https://402index.io/service/abc-123</link>'), 'Item should have link')
    assert.ok(xml.includes('<guid isPermaLink="true">https://402index.io/service/abc-123</guid>'), 'Item should have guid')
    assert.ok(xml.includes('<pubDate>'), 'Item should have pubDate')
  })

  it('renders item description and category', () => {
    const xml = feedXml({ services: [SAMPLE_SERVICE], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<description>A test API for weather data</description>'), 'Item should have description')
    assert.ok(xml.includes('<category>data/weather</category>'), 'Item should have category')
  })

  it('renders l402:endpoint tag with url and method', () => {
    const xml = feedXml({ services: [SAMPLE_SERVICE], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<l402:endpoint url="https://api.example.com/weather" method="GET"/>'),
      'Should include l402:endpoint with url and method')
  })

  it('renders l402:protocol tag with type, health, reliability', () => {
    const xml = feedXml({ services: [SAMPLE_SERVICE], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<l402:protocol type="L402" health="healthy" reliability="0.94"/>'),
      'Should include l402:protocol')
  })

  it('renders l402:price tag with sats and usd', () => {
    const xml = feedXml({ services: [SAMPLE_SERVICE], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<l402:price sats="100" usd="0.08"/>'), 'Should include l402:price')
  })

  it('renders multiple items', () => {
    const xml = feedXml({ services: [SAMPLE_SERVICE, SAMPLE_SERVICE_X402], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    const itemCount = (xml.match(/<item>/g) || []).length
    assert.equal(itemCount, 2, 'Should render 2 items')
    assert.ok(xml.includes('Test API'), 'Should include first service')
    assert.ok(xml.includes('Image Generator'), 'Should include second service')
  })

  it('escapes XML entities in service names', () => {
    const service = { ...SAMPLE_SERVICE, name: 'API\'s "Best" <Data> & More' }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('&apos;'), 'Should escape single quotes')
    assert.ok(xml.includes('&quot;'), 'Should escape double quotes')
    assert.ok(xml.includes('&lt;'), 'Should escape less than')
    assert.ok(xml.includes('&amp;'), 'Should escape ampersand')
  })

  it('escapes XML entities in URLs with ampersands', () => {
    const service = { ...SAMPLE_SERVICE, url: 'https://api.example.com/data?foo=1&bar=2' }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('foo=1&amp;bar=2'), 'Should escape ampersands in URLs')
  })

  it('handles null description gracefully', () => {
    const service = { ...SAMPLE_SERVICE, description: null }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<item>'), 'Should still render item')
    assert.ok(xml.includes('<description>'), 'Should have description tag')
  })

  it('handles null price values', () => {
    const service = { ...SAMPLE_SERVICE, price_sats: null, price_usd: null }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<l402:price sats="" usd=""/>'), 'Should render empty price attributes')
  })

  it('handles null category', () => {
    const service = { ...SAMPLE_SERVICE, category: null }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('<item>'), 'Should still render item')
  })

  it('handles null reliability_score', () => {
    const service = { ...SAMPLE_SERVICE, reliability_score: null }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('reliability="0"'), 'Should default reliability to 0')
  })

  it('defaults http_method to GET when null', () => {
    const service = { ...SAMPLE_SERVICE, http_method: null }
    const xml = feedXml({ services: [service], selfUrl: 'https://402index.io/feed.xml', filters: {} })
    assert.ok(xml.includes('method="GET"'), 'Should default method to GET')
  })
})
