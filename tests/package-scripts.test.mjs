import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the test script passes an explicit glob, not a bare directory', () => {
  const script = pkg.scripts.test;
  assert.equal(typeof script, 'string');
  assert.match(script, /--test-concurrency=1/);
  // On Node 22 (the engines floor) a bare directory argument is resolved as a
  // module path, so `node --test tests/` fails with MODULE_NOT_FOUND before a
  // single test runs. Node 26 accepts it, which is why this stayed green
  // locally while CI stayed red.
  const last = script.trim().split(/\s+/).at(-1);
  assert.notEqual(last, 'tests');
  assert.notEqual(last, 'tests/');
  assert.match(last, /^"?tests\/[^\s"]*\.test\.mjs"?$/, `test script must name a test-file glob, got ${last}`);
});
