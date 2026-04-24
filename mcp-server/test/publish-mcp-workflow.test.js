import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

  it('e. contains npm_check step with id: npm_check', () => {
    assert.ok(workflowContent !== null, 'publish-mcp.yml must exist');
    assert.ok(
      workflowContent.includes('id: npm_check'),
      'Expected a step with id: npm_check'
    );
    assert.ok(
      workflowContent.includes('already_published'),
      'npm_check step must set already_published output'
    );
  });

  it('f. Publish to npm step is gated on npm_check', () => {
    assert.ok(workflowContent !== null, 'publish-mcp.yml must exist');
    // Find the "Publish to npm" step and verify it has an if: referencing npm_check
    const publishIdx = workflowContent.indexOf('Publish to npm (OIDC trusted publisher)');
    assert.ok(publishIdx !== -1, 'Expected Publish to npm step');
    // The if: condition should appear near the step (within ~200 chars before it or as part of the step block)
    const stepBlock = workflowContent.substring(Math.max(0, publishIdx - 200), publishIdx + 200);
    assert.ok(
      stepBlock.includes("steps.npm_check.outputs.already_published != 'true'"),
      'Publish to npm step must have if: steps.npm_check.outputs.already_published != \'true\''
    );
  });

  it('g. Wait for npm registry propagation step is gated on npm_check', () => {
    assert.ok(workflowContent !== null, 'publish-mcp.yml must exist');
    const waitIdx = workflowContent.indexOf('Wait for npm registry propagation');
    assert.ok(waitIdx !== -1, 'Expected Wait for npm registry propagation step');
    const stepBlock = workflowContent.substring(Math.max(0, waitIdx - 200), waitIdx + 200);
    assert.ok(
      stepBlock.includes("steps.npm_check.outputs.already_published != 'true'"),
      'Wait for npm registry propagation step must have if: steps.npm_check.outputs.already_published != \'true\''
    );
  });

  it('h. Publish to MCP Registry step does NOT have npm_check gate', () => {
    assert.ok(workflowContent !== null, 'publish-mcp.yml must exist');
    const registryIdx = workflowContent.indexOf('Publish to MCP Registry');
    assert.ok(registryIdx !== -1, 'Expected Publish to MCP Registry step');
    // Check the step block around the registry publish — it should NOT reference npm_check
    const stepBlock = workflowContent.substring(Math.max(0, registryIdx - 200), registryIdx + 50);
    assert.ok(
      !stepBlock.includes('npm_check'),
      'Publish to MCP Registry step must NOT be gated on npm_check'
    );
  });
});

// ─── Constraint #12: no hardcoded production URL in mock-based test files ─────

describe('constraint #12 — no hardcoded 402index.io in mock-based test files', () => {
  const MOCK_TEST_FILES = ['tools.test.js', 'mcp-0.2.5-parity.test.js', 'mcp-verified.test.js'];

  for (const filename of MOCK_TEST_FILES) {
    it(`${filename} does not contain hardcoded https://402index.io as a fetch URL`, () => {
      const content = readFileSync(join(__dirname, filename), 'utf8');
      // Filter out lines that are purely package.json metadata assertions (e.g. homepage, author)
      const lines = content.split('\n');
      const violating = lines.filter((line) => {
        if (!line.includes('https://402index.io')) return false;
        // Allow: string comparisons against package.json field values (homepage, author, bugs.url)
        if (/assert\.\w+\(.*https:\/\/402index\.io/.test(line)) return false;
        return true;
      });
      assert.strictEqual(
        violating.length,
        0,
        `${filename} contains ${violating.length} hardcoded https://402index.io reference(s) used as fetch URL — the module under test owns the URL, tests must not hardcode it:\n${violating.map((l) => l.trim()).join('\n')}`
      );
    });
  }
});
