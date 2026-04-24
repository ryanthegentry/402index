import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { constantTimeEqual } from '../src/util/constant-time.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('constantTimeEqual', () => {
  it('a — equal inputs of equal length → true', () => {
    assert.equal(constantTimeEqual('hello', 'hello'), true)
    assert.equal(constantTimeEqual('secret-token-1234', 'secret-token-1234'), true)
    assert.equal(constantTimeEqual('', ''), true)
  })

  it('b — unequal inputs of equal length → false', () => {
    assert.equal(constantTimeEqual('hello', 'world'), false)
    assert.equal(constantTimeEqual('aaaa', 'aaab'), false)
  })

  it('c — inputs of unequal length → false', () => {
    assert.equal(constantTimeEqual('short', 'much-longer-string'), false)
    assert.equal(constantTimeEqual('abc', 'ab'), false)
    assert.equal(constantTimeEqual('', 'notempty'), false)
  })

  it('d — structural regression gate: source must not contain length-branch pattern', () => {
    const sourcePath = resolve(__dirname, '../src/util/constant-time.js')
    const source = readFileSync(sourcePath, 'utf8')
    assert.equal(
      source.includes('bufA.length !== bufB.length'),
      false,
      'source must not contain "bufA.length !== bufB.length"'
    )
    assert.equal(
      source.includes('timingSafeEqual(bufA, bufA)'),
      false,
      'source must not contain "timingSafeEqual(bufA, bufA)"'
    )
  })

  it('e — statistical timing gate: CV of per-length mean timings < 10%', { skip: process.env.CI === 'true' || !process.env.RUN_TIMING_TESTS }, () => {
    const secret = 'known-secret-of-length-32!@#$%^&'
    const lengths = [4, 16, 32, 64, 128]
    const N = 10000
    const WARMUP = 2000
    const means = []

    // global warmup to stabilize JIT before any measurement
    for (let i = 0; i < 5000; i++) {
      constantTimeEqual('warmup-input', secret)
    }

    for (const len of lengths) {
      const input = 'x'.repeat(len)
      // per-length warmup
      for (let i = 0; i < WARMUP; i++) {
        constantTimeEqual(input, secret)
      }
      // measure
      const start = process.hrtime.bigint()
      for (let i = 0; i < N; i++) {
        constantTimeEqual(input, secret)
      }
      const elapsed = Number(process.hrtime.bigint() - start)
      means.push(elapsed / N)
    }

    const avg = means.reduce((a, b) => a + b, 0) / means.length
    const variance = means.reduce((a, b) => a + (b - avg) ** 2, 0) / means.length
    const stddev = Math.sqrt(variance)
    const cv = stddev / avg

    assert.ok(
      cv < 0.1,
      `CV of per-length mean timings is ${(cv * 100).toFixed(1)}%, expected < 10%. Means: ${means.map(m => m.toFixed(0)).join(', ')}`
    )
  })
})
