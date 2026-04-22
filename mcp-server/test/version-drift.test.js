import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

// Read package.json at test time — never cached — so version bumps without rebuild are caught
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expectedVersion = pkg.version

describe('version drift (runtime)', () => {
  it('McpServer advertises version matching package.json', async () => {
    const { server } = await import('../dist/index.js')
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const serverVersion = client.getServerVersion()
    assert.strictEqual(
      serverVersion?.version,
      expectedVersion,
      `McpServer constructor version "${serverVersion?.version}" does not match package.json version "${expectedVersion}". Update both in lockstep.`
    )
    await client.close()
  })

  it('USER_AGENT export contains package.json version', async () => {
    const { USER_AGENT } = await import('../dist/index.js')
    assert.ok(
      USER_AGENT && USER_AGENT.includes(expectedVersion),
      `USER_AGENT "${USER_AGENT}" does not contain package.json version "${expectedVersion}". Update both in lockstep.`
    )
  })

  it('USER_AGENT matches exact "402index-mcp/<version>" format', async () => {
    const { USER_AGENT } = await import('../dist/index.js')
    assert.strictEqual(
      USER_AGENT,
      `402index-mcp/${expectedVersion}`,
      `USER_AGENT must be exactly "402index-mcp/${expectedVersion}", got "${USER_AGENT}"`
    )
  })
})
