import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIp, resolveAndCheck } from '../src/health/checker.js'

describe('isPrivateIp', () => {
  // Private ranges that should be blocked
  it('blocks 127.0.0.0/8 (loopback)', () => {
    assert.equal(isPrivateIp('127.0.0.1'), true)
    assert.equal(isPrivateIp('127.255.255.255'), true)
  })

  it('blocks 10.0.0.0/8', () => {
    assert.equal(isPrivateIp('10.0.0.1'), true)
    assert.equal(isPrivateIp('10.255.255.255'), true)
  })

  it('blocks 172.16.0.0/12', () => {
    assert.equal(isPrivateIp('172.16.0.1'), true)
    assert.equal(isPrivateIp('172.31.255.255'), true)
    assert.equal(isPrivateIp('172.15.255.255'), false) // Outside range
    assert.equal(isPrivateIp('172.32.0.0'), false) // Outside range
  })

  it('blocks 192.168.0.0/16', () => {
    assert.equal(isPrivateIp('192.168.0.1'), true)
    assert.equal(isPrivateIp('192.168.255.255'), true)
  })

  it('blocks 169.254.0.0/16 (link-local)', () => {
    assert.equal(isPrivateIp('169.254.169.254'), true)
    assert.equal(isPrivateIp('169.254.0.1'), true)
  })

  it('blocks 0.0.0.0/8', () => {
    assert.equal(isPrivateIp('0.0.0.0'), true)
  })

  it('blocks 100.64.0.0/10 (CGNAT)', () => {
    assert.equal(isPrivateIp('100.64.0.1'), true)
    assert.equal(isPrivateIp('100.127.255.255'), true)
    assert.equal(isPrivateIp('100.63.255.255'), false) // Outside range
    assert.equal(isPrivateIp('100.128.0.0'), false) // Outside range
  })

  it('blocks IPv6 loopback (::1)', () => {
    assert.equal(isPrivateIp('::1'), true)
  })

  it('blocks IPv6 link-local (fe80::/10)', () => {
    assert.equal(isPrivateIp('fe80::1'), true)
  })

  it('blocks IPv6 ULA (fd00::/8)', () => {
    assert.equal(isPrivateIp('fd00::1'), true)
    assert.equal(isPrivateIp('fc00::1'), true)
  })

  it('blocks IPv4-mapped IPv6 (::ffff:127.0.0.1)', () => {
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateIp('::ffff:10.0.0.1'), true)
    assert.equal(isPrivateIp('::ffff:169.254.169.254'), true)
  })

  // Public IPs that should be allowed
  it('allows public IPs', () => {
    assert.equal(isPrivateIp('1.1.1.1'), false)
    assert.equal(isPrivateIp('8.8.8.8'), false)
    assert.equal(isPrivateIp('93.184.216.34'), false)
  })
})

describe('resolveAndCheck', () => {
  it('blocks localtest.me (resolves to 127.0.0.1)', async () => {
    const result = await resolveAndCheck('http://localtest.me/test')
    assert.ok(result !== null, 'localtest.me should be blocked')
    assert.match(result, /blocked/)
  })

  it('blocks 169.254.169.254 directly', async () => {
    const result = await resolveAndCheck('http://169.254.169.254/latest/meta-data/')
    assert.ok(result !== null, '169.254.169.254 should be blocked')
    assert.match(result, /blocked/)
  })

  it('allows a normal public IP like 1.1.1.1', async () => {
    const result = await resolveAndCheck('http://1.1.1.1/')
    assert.equal(result, null, '1.1.1.1 should be allowed')
  })

  it('allows a normal public domain', async () => {
    const result = await resolveAndCheck('https://example.com/')
    assert.equal(result, null, 'example.com should be allowed')
  })
})
