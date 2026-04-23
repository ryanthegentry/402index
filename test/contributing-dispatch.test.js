import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contributing = readFileSync(resolve(__dirname, '..', 'CONTRIBUTING.md'), 'utf8');

describe('CONTRIBUTING.md dispatch reference', () => {
  it('contains dispatch/402index location comment', () => {
    assert.ok(
      contributing.includes('dispatch/402index'),
      'CONTRIBUTING.md must reference dispatch/402index location'
    );
  });

  it('has the dispatch comment as an HTML comment', () => {
    assert.match(
      contributing,
      /<!--.*dispatch\/402index.*-->/,
      'dispatch reference must be an HTML comment'
    );
  });

  it('has the dispatch comment at the end of the file', () => {
    const trimmed = contributing.trimEnd();
    assert.ok(
      trimmed.endsWith('<!-- Dispatch system lives at ~/workspace/agent-state/dispatch/402index/ -->'),
      'CONTRIBUTING.md must end with the dispatch HTML comment'
    );
  });
});
