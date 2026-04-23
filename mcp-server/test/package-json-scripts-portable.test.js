import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

test('package.json test script does not rely on bash globstar', () => {
  const testScript = pkg.scripts?.test;
  assert.ok(testScript, 'package.json must define scripts.test');
  assert.ok(
    !testScript.includes('**'),
    `scripts.test contains "**" globstar which does not expand under POSIX sh. ` +
      `npm executes scripts via /bin/sh (dash on Linux); use single-star "test/*.test.js" ` +
      `or explicit paths instead. Current: ${JSON.stringify(testScript)}`
  );
});
