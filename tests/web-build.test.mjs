import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWeb, WEB_MAX_BYTES } from '../scripts/build-web.mjs';

const root = process.cwd();
const dist = join(root, 'apps', 'web', 'dist');

test('buildWeb produces a self-contained static bundle under the budget', () => {
  const result = buildWeb();
  assert.ok(existsSync(join(dist, 'index.html')));
  assert.ok(existsSync(join(dist, 'styles.css')));
  assert.ok(existsSync(join(dist, 'apps', 'web', 'src', 'main.js')));
  assert.ok(result.totalBytes > 0);
  assert.ok(result.totalBytes <= WEB_MAX_BYTES, `${result.totalBytes} bytes`);

  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /type="module"/);
  assert.match(html, /src="\.\/apps\/web\/src\/main\.js"/);
  assert.equal(/https?:\/\//.test(html), false, 'no external URLs in HTML');
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'no inline scripts');
  assert.match(html, /<h2 id="summary-heading" data-copy="summaryTitle">/);
  assert.match(html, /<h3 id="detail-heading" data-copy="detailTitle">/);
  assert.match(html, /<dt data-copy="statusLabel">Status<\/dt>/);
  assert.equal(/<dt data-copy="pass">/.test(html), false, 'status label must not reuse the pass value');
});

test('buildWeb rejects an externally hosted stylesheet or script', () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.equal(/<link[^>]+href="https?:/i.test(html), false);
  assert.equal(/@import\s+url\(\s*["']?https?:/i.test(readFileSync(join(dist, 'styles.css'), 'utf8')), false);
});
