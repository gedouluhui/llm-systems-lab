import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDevToolsActivePort,
  isLocalResource,
  summarizeReport,
  SECTIONS,
} from '../scripts/e2e-web.mjs';

test('DevTools port file is parsed strictly', () => {
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc\n'), {
    port: 9222,
    wsPath: '/devtools/browser/abc',
  });
  assert.deepEqual(parseDevToolsActivePort('0\n/devtools/browser/x'), {
    port: 0,
    wsPath: '/devtools/browser/x',
  });
  for (const bad of ['', 'abc\n/x', '9222', '9222\n', '99999\n/devtools/browser/x']) {
    assert.throws(() => parseDevToolsActivePort(bad), /DevTools/, bad);
  }
});

test('a partial e2e run is never accepted as green', () => {
  const pass = (name) => ({ name, ok: true, detail: 'ok' });
  const full = summarizeReport(SECTIONS, SECTIONS.map(pass));
  assert.equal(full.ok, true);
  assert.equal(full.full, true);
  assert.deepEqual(full.executed, SECTIONS);

  const partial = summarizeReport(['load', 'narrow'], [pass('load'), pass('narrow')]);
  assert.equal(partial.ok, false);
  assert.equal(partial.full, false);
  assert.deepEqual(partial.requested, ['load', 'narrow']);
  assert.deepEqual(partial.executed, ['load', 'narrow']);

  const oneFailed = summarizeReport(
    SECTIONS,
    SECTIONS.map((name) => ({ name, ok: name !== 'narrow', detail: '' })),
  );
  assert.equal(oneFailed.ok, false);
  assert.equal(oneFailed.full, true);

  const duplicated = summarizeReport(
    [...SECTIONS.slice(0, SECTIONS.length - 1), 'load'],
    [...SECTIONS.slice(0, SECTIONS.length - 1), 'load'].map(pass),
  );
  assert.equal(duplicated.full, false);
  assert.equal(duplicated.ok, false);
});

test('resource origins are compared exactly', () => {
  const origin = 'http://127.0.0.1:4173';
  assert.equal(isLocalResource('http://127.0.0.1:4173/apps/web/src/main.js', origin), true);
  assert.equal(isLocalResource('http://127.0.0.1:4173', origin), true);
  assert.equal(isLocalResource('http://127.0.0.1:4173.evil.test/x', origin), false);
  assert.equal(isLocalResource('https://cdn.example/x.js', origin), false);
  assert.equal(isLocalResource('data:image/svg+xml,x', origin), false);
  assert.equal(isLocalResource('not a url', origin), false);
});
