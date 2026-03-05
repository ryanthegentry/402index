import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homePage } from '../src/views/home.js'
import { aboutPage } from '../src/views/about.js'

describe('two-tier stats bar', () => {
  it('renders both totalIndexed and payment-verified counts', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: {
        verified: 1437,
        totalIndexed: 13690,
        healthy: 99,
        degraded: 1029,
        down: 308,
        unknown: 1,
        distinctServices: 508,
        distinctProviders: 280,
        l402Providers: 23,
        baseProviders: 261,
        solanaProviders: 5,
        allL402Providers: 23,
        allBaseProviders: 280,
        allSolanaProviders: 5,
      },
      categories: [],
    })

    assert.ok(html.includes('13,690'), 'should show totalIndexed formatted with commas')
    assert.ok(html.includes('endpoints indexed'), 'should label totalIndexed as endpoints indexed')
    assert.ok(html.includes('1,437'), 'should show filtered total formatted with commas')
    assert.ok(html.includes('payment-verified'), 'should label filtered total as payment-verified')
    assert.ok(html.includes('stats-headline'), 'should have headline div')
    assert.ok(html.includes('stats-detail'), 'should have detail div')
  })

  it('shows health breakdown in detail line', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: {
        verified: 100,
        totalIndexed: 500,
        healthy: 80,
        degraded: 15,
        down: 5,
        unknown: 0,
        distinctServices: 50,
        distinctProviders: 30,
      },
      categories: [],
    })

    assert.ok(html.includes('>80<'), 'should show healthy count')
    assert.ok(html.includes('>15<'), 'should show degraded count')
    assert.ok(html.includes('>5<'), 'should show down count')
    assert.ok(html.includes('50'), 'should show distinct services')
    assert.ok(html.includes('30'), 'should show distinct providers')
  })
})

describe('protocol bar verification fractions', () => {
  it('shows fraction when all providers > filtered providers', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: {
        verified: 100,
        totalIndexed: 500,
        healthy: 80,
        degraded: 10,
        down: 5,
        unknown: 5,
        l402Providers: 23,
        baseProviders: 261,
        solanaProviders: 5,
        allL402Providers: 23,
        allBaseProviders: 280,
        allSolanaProviders: 8,
      },
      categories: [],
    })

    // L402: 23/23 — all verified, so no fraction
    assert.ok(!html.includes('/23'), 'L402 should not show fraction when all verified')
    // Base: 261/280 — gap, so show fraction
    assert.ok(html.includes('/280'), 'Base should show /280 total')
    // Solana: 5/8 — gap, so show fraction
    assert.ok(html.includes('/8'), 'Solana should show /8 total')
    assert.ok(html.includes('class="pct-of"'), 'should use pct-of class for fraction')
  })

  it('does not show fraction when all providers are verified', () => {
    const html = homePage({
      services: [],
      total: 0,
      limit: 50,
      offset: 0,
      filters: {},
      stats: {
        verified: 100,
        totalIndexed: 100,
        healthy: 80,
        degraded: 10,
        down: 5,
        unknown: 5,
        l402Providers: 23,
        baseProviders: 50,
        solanaProviders: 5,
        allL402Providers: 23,
        allBaseProviders: 50,
        allSolanaProviders: 5,
      },
      categories: [],
    })

    assert.ok(!html.includes('class="pct-of"'), 'should not show fractions when all counts match')
  })
})

describe('about page methodology', () => {
  it('includes methodology section', () => {
    const html = aboutPage()
    assert.ok(html.includes('Methodology'), 'should have Methodology heading')
    assert.ok(html.includes('Endpoints indexed'), 'should explain endpoints indexed')
    assert.ok(html.includes('Payment-verified'), 'should explain payment-verified')
    assert.ok(html.includes('WWW-Authenticate'), 'should mention L402 header')
    assert.ok(html.includes('PAYMENT-REQUIRED'), 'should mention x402 header')
    assert.ok(html.includes('Health status'), 'should explain health status')
    assert.ok(html.includes('every hour'), 'should mention check frequency')
  })
})
