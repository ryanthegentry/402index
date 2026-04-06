import { app } from '../../src/server.js'

let server = null
let baseUrl = null

export async function startServer() {
  if (server) return baseUrl
  return new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      resolve(baseUrl)
    })
    server.on('error', reject)
  })
}

export async function stopServer() {
  if (!server) return
  return new Promise(r => { server.close(r); server = null; baseUrl = null })
}
