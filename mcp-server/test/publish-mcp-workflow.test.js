import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'publish-mcp.yml');

let workflowContent;
try {
  workflowContent = readFileSync(workflowPath, 'utf8');
} catch {
  workflowContent = null;
}

describe('publish-mcp workflow structural assertions', () => {
  it('a. file exists', () => {
    assert.ok(workflowContent !== null, 'Expected .github/workflows/publish-mcp.yml to exist');
  });

  it('b. contains Validate server.json schema step with mcp-publisher validate', () => {
    assert.ok(
      workflowContent !== null,
      'publish-mcp.yml must exist before checking for validate step'
    );
    assert.ok(
      workflowContent.includes('Validate server.json schema'),
      'Expected a step named "Validate server.json schema" in publish-mcp.yml'
    );
    assert.ok(
      workflowContent.includes('mcp-publisher validate mcp-server/server.json'),
      'Expected step to run: ./mcp-publisher validate mcp-server/server.json'
    );
  });

  it('c. Validate step appears before Publish to MCP Registry step', () => {
    assert.ok(workflowContent !== null, 'publish-mcp.yml must exist');
    const validateIdx = workflowContent.indexOf('Validate server.json schema');
    const publishIdx = workflowContent.indexOf('Publish to MCP Registry');
    assert.ok(validateIdx !== -1, 'Expected Validate server.json schema step');
    assert.ok(publishIdx !== -1, 'Expected Publish to MCP Registry step');
    assert.ok(
      validateIdx < publishIdx,
      'Validate server.json schema step must appear before Publish to MCP Registry step'
    );
  });

  it('d. Validate step appears after Login to MCP Registry via OIDC step', () => {
    assert.ok(workflowContent !== null, 'publish-mcp.yml must exist');
    const loginIdx = workflowContent.indexOf('Login to MCP Registry via OIDC');
    const validateIdx = workflowContent.indexOf('Validate server.json schema');
    assert.ok(loginIdx !== -1, 'Expected Login to MCP Registry via OIDC step');
    assert.ok(validateIdx !== -1, 'Expected Validate server.json schema step');
    assert.ok(
      loginIdx < validateIdx,
      'Validate server.json schema step must appear after Login to MCP Registry via OIDC step'
    );
  });
});
