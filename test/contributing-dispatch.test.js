import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contributing = readFileSync(resolve(__dirname, '..', 'CONTRIBUTING.md'), 'utf8');
const agents = readFileSync(resolve(__dirname, '..', 'AGENTS.md'), 'utf8');
const claude = readFileSync(resolve(__dirname, '..', 'CLAUDE.md'), 'utf8');

describe('public agent workflow docs', () => {
  it('keeps private dispatch paths out of CONTRIBUTING.md', () => {
    assert.doesNotMatch(
      contributing,
      /agent-state|~\/workspace|dispatch\/402index/,
      'CONTRIBUTING.md must not expose private dispatch paths'
    );
  });

  it('documents shared agent guidance in AGENTS.md', () => {
    assert.match(
      agents,
      /Shared instructions for AI coding agents/,
      'AGENTS.md must be the public cross-tool agent entry point'
    );
  });

  it('documents the AI-assisted workflow in CLAUDE.md', () => {
    assert.match(
      claude,
      /## AI-Assisted Workflow/,
      'CLAUDE.md must document how AI agent work is reviewed'
    );
  });
});
