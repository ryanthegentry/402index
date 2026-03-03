/**
 * Unit tests for the notification module.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { sendRegistrationNotification } from '../src/services/notify.js'

const mockService = {
  name: 'Test API',
  url: 'https://api.test.com/resource',
  protocol: 'L402',
  provider: 'Test Org',
  contact_email: 'test@test.com',
  category: 'test',
  status: 'pending',
}

describe('sendRegistrationNotification', () => {
  const originalKey = process.env.RESEND_API_KEY
  const originalEmail = process.env.NOTIFY_EMAIL
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey !== undefined) {
      process.env.RESEND_API_KEY = originalKey
    } else {
      delete process.env.RESEND_API_KEY
    }
    if (originalEmail !== undefined) {
      process.env.NOTIFY_EMAIL = originalEmail
    } else {
      delete process.env.NOTIFY_EMAIL
    }
  })

  it('silently skips when RESEND_API_KEY is not set', async () => {
    delete process.env.RESEND_API_KEY
    let fetchCalled = false
    global.fetch = async () => { fetchCalled = true }
    await sendRegistrationNotification(mockService)
    assert.ok(!fetchCalled, 'fetch should not be called without API key')
  })

  it('calls Resend API when key is configured', async () => {
    process.env.RESEND_API_KEY = 'test-key-123'
    process.env.NOTIFY_EMAIL = 'admin@test.com'
    let capturedUrl, capturedOpts
    global.fetch = async (url, opts) => {
      capturedUrl = url
      capturedOpts = opts
      return { ok: true, json: async () => ({ id: 'email-123' }) }
    }
    await sendRegistrationNotification(mockService)
    assert.equal(capturedUrl, 'https://api.resend.com/emails')
    assert.equal(capturedOpts.method, 'POST')
    const body = JSON.parse(capturedOpts.body)
    assert.equal(body.to, 'admin@test.com')
    assert.ok(body.subject.includes('Test API'))
    assert.ok(body.html.includes('Test API'))
    assert.ok(capturedOpts.headers['Authorization'].includes('test-key-123'))
  })

  it('does not throw on fetch failure', async () => {
    process.env.RESEND_API_KEY = 'test-key-123'
    global.fetch = async () => { throw new Error('Network error') }
    // Should not throw
    await sendRegistrationNotification(mockService)
  })

  it('does not throw on non-ok response', async () => {
    process.env.RESEND_API_KEY = 'test-key-123'
    global.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })
    await sendRegistrationNotification(mockService)
  })

  it('escapes HTML in service fields', async () => {
    process.env.RESEND_API_KEY = 'test-key-123'
    let capturedBody
    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true }
    }
    await sendRegistrationNotification({
      ...mockService,
      name: '<script>alert("xss")</script>',
    })
    assert.ok(!capturedBody.html.includes('<script>'))
    assert.ok(capturedBody.html.includes('&lt;script&gt;'))
  })
})
