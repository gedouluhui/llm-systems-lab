import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer, resolveRequestPath } from '../scripts/serve-web.mjs';

test('resolveRequestPath serves only files under the root', () => {
  // macOS resolves /var to /private/var; the server returns real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-root-')));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'sub', 'app.js'), 'export {};');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, 'sub', '.hidden'), 'x');

  assert.equal(resolveRequestPath(root, '/'), join(root, 'index.html'));
  assert.equal(resolveRequestPath(root, '/sub/app.js'), join(root, 'sub', 'app.js'));
  for (const bad of [
    '/../secret',
    '/%2e%2e/secret',
    '/sub/..%2f..%2fsecret',
    '/C:/Windows/win.ini',
    '/nul\u0000',
    '/sub%5capp.js',
    '/.env',
    '/%2e%65nv',
    '/sub/.hidden',
  ]) {
    assert.equal(resolveRequestPath(root, bad), null, bad);
  }
  assert.equal(resolveRequestPath(root, '/missing.js'), null);
  assert.equal(resolveRequestPath(root, '/sub'), null, 'directories are not served');
});

test('server sets security headers and rejects non-read methods', async () => {
  // macOS resolves /var to /private/var; the server returns real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-root-')));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>lab</title>');
  const server = createStaticServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');

    const missing = await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`);
    assert.equal(missing.status, 404);

    const post = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    assert.equal(post.status, 405);

    const head = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
