import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRouter } from './helpers/server.js';

test('T1: SDK v2 client gets a well-formed server/discover result', async (t) => {
  const { baseUrl, close } = await startRouter();
  t.after(close);

  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client(
    { name: 'scripted-test-client', version: '0.0.1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());

  const discovered = await client.discover();
  assert.ok(discovered, 'discover result present');
  assert.ok(
    discovered.supportedVersions.includes('2026-07-28'),
    `supportedVersions must include 2026-07-28, got ${JSON.stringify(discovered.supportedVersions)}`
  );

  const tools = await client.listTools();
  assert.ok(Array.isArray(tools.tools), 'tools list present');
});
