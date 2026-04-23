import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(__dirname, '..', 'server.json'), 'utf8'));

test('package.json#mcpName matches server.json#name (MCP Registry ownership verification)', () => {
  assert.ok(pkg.mcpName, 'package.json must define mcpName for MCP Registry npm ownership verification');
  assert.ok(server.name, 'server.json must define name');
  assert.strictEqual(
    pkg.mcpName,
    server.name,
    `package.json#mcpName (${JSON.stringify(pkg.mcpName)}) must exactly match ` +
      `server.json#name (${JSON.stringify(server.name)}). Per ` +
      `https://github.com/modelcontextprotocol/registry/blob/fa450110e47d2f6a1e789da6f7f87b928fbaa417/docs/modelcontextprotocol-io/package-types.mdx — ` +
      `the MCP Registry rejects publishes where these diverge.`
  );
});
