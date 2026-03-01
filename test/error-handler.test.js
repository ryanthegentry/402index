import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { notFoundHandler, errorHandler } from '../src/middleware/error-handler.js'

describe('notFoundHandler', () => {
  it('creates a 404 error and calls next', () => {
    let passedErr = null
    const next = (err) => { passedErr = err }
    notFoundHandler({}, {}, next)
    assert.ok(passedErr)
    assert.equal(passedErr.status, 404)
    assert.equal(passedErr.message, 'Not Found')
  })
})

describe('errorHandler', () => {
  function mockRes() {
    const res = {
      statusCode: null,
      body: null,
      headers: {},
      status(code) { res.statusCode = code; return res },
      json(data) { res.body = data; res.type = 'json' },
      send(data) { res.body = data; res.type = 'html' },
    }
    return res
  }

  it('returns JSON for API routes', () => {
    const res = mockRes()
    const err = new Error('Test error')
    err.status = 400
    errorHandler(err, { method: 'GET', originalUrl: '/api/v1/services' }, res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.type, 'json')
  })

  it('returns HTML for web routes', () => {
    const res = mockRes()
    const err = new Error('Not Found')
    err.status = 404
    errorHandler(err, { method: 'GET', originalUrl: '/about' }, res, () => {})
    assert.equal(res.statusCode, 404)
    assert.equal(res.type, 'html')
    assert.ok(res.body.includes('404'))
  })

  it('defaults to 500 when no status on error', () => {
    const res = mockRes()
    errorHandler(new Error('boom'), { method: 'GET', originalUrl: '/about' }, res, () => {})
    assert.equal(res.statusCode, 500)
  })

  it('returns "Not Found" message for 404', () => {
    const res = mockRes()
    const err = new Error('Not Found')
    err.status = 404
    errorHandler(err, { method: 'GET', originalUrl: '/api/v1/test' }, res, () => {})
    assert.equal(res.body.error, 'Not Found')
  })

  it('returns "Internal Server Error" for 500', () => {
    const res = mockRes()
    errorHandler(new Error('boom'), { method: 'GET', originalUrl: '/api/v1/test' }, res, () => {})
    assert.equal(res.body.error, 'Internal Server Error')
  })
})
