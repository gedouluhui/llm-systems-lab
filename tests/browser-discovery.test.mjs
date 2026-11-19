import assert from 'node:assert/strict';
import { existsSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const moduleUrl = new URL('../scripts/browser-discovery.mjs', import.meta.url);
// Keep the first red an explicit missing-feature assertion, not an import crash.
const discovery = existsSync(moduleUrl) ? await import(moduleUrl.href) : {};
function discover(options) {
  assert.equal(typeof discovery.browserCandidates, 'function', 'portable browser discovery must exist');
  return discovery.browserCandidates(options);
}

for (const candidate of [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]) {
  test(`Windows discovers the installed executable: ${candidate}`, () => {
    assert.deepEqual(discover({ platform: 'win32', env: {}, exists: (file) => file === candidate }), [candidate]);
  });
}

for (const candidate of [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]) {
  test(`macOS preserves spaces in the application executable: ${candidate}`, () => {
    assert.deepEqual(discover({ platform: 'darwin', env: {}, exists: (file) => file === candidate }), [candidate]);
  });
}

for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
  test(`Linux resolves ${command} through PATH without a shell`, () => {
    const installed = `/opt/browser tools/${command}`;
    const visited = [];
    assert.deepEqual(discover({
      platform: 'linux',
      env: { PATH: '/missing:/opt/browser tools:/usr/bin' },
      exists(file) { visited.push(file); return file === installed; },
    }), [installed]);
    assert.ok(visited.includes(`/missing/${command}`));
  });
}

test('PATH discovery excludes empty/relative entries and deduplicates actual executable paths', () => {
  const visited = [];
  assert.deepEqual(discover({
    platform: 'linux',
    env: { PATH: ':.:relative:/opt/bin:/opt/bin:' },
    exists(file) { visited.push(file); return file === '/opt/bin/chromium'; },
  }), ['/opt/bin/chromium']);
  assert.ok(visited.every((file) => file.startsWith('/opt/bin/')));
});

test('Windows keeps Edge before Chrome and excludes missing candidates', () => {
  const installed = new Set([
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]);
  assert.deepEqual(discover({ platform: 'win32', env: {}, exists: (file) => installed.has(file) }), [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]);
});

test('LAB_BROWSER is exclusive on every platform, including paths with spaces and shell metacharacters', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const override = platform === 'win32' ? 'D:/browser tools/Chrome & Edge.exe' : '/opt/browser tools/chrome;$HOME';
    const visited = [];
    assert.deepEqual(discover({
      platform, env: { LAB_BROWSER: override, PATH: '/usr/bin' },
      exists(file) { visited.push(file); return true; },
    }), [override]);
    assert.deepEqual(visited, [override], 'override must not even probe fallback browsers');
  }
});

test('a missing LAB_BROWSER never falls back to an installed browser', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const visited = [];
    assert.throws(() => discover({
      platform, env: { LAB_BROWSER: '/missing/browser', PATH: '/usr/bin' },
      exists(file) { visited.push(file); return file !== '/missing/browser'; },
    }), /LAB_BROWSER/);
    assert.deepEqual(visited, ['/missing/browser']);
  }
});

test('an explicitly empty LAB_BROWSER is invalid rather than an invitation to fall back', () => {
  for (const LAB_BROWSER of ['', '   ', '\t']) {
    assert.throws(() => discover({
      platform: 'linux', env: { LAB_BROWSER, PATH: '/usr/bin' }, exists: () => true,
    }), /LAB_BROWSER/);
  }
});

test('no installed browser fails closed on all platforms and on an unsupported platform', () => {
  for (const platform of ['win32', 'linux', 'darwin', 'unknown']) {
    assert.throws(() => discover({ platform, env: { PATH: '/empty' }, exists: () => false }), /No .*browser/i);
  }
});

test('Linux without PATH does not invent an installation path', () => {
  assert.throws(() => discover({
    platform: 'linux', env: {}, exists() { assert.fail('no PATH means no candidates to probe'); },
  }), /No .*browser/i);
});

test('a relative override resolves to an absolute executable instead of a bare PATH command', () => {
  const relative = path.relative(process.cwd(), process.execPath);
  assert.deepEqual(discover({ env: { LAB_BROWSER: relative } }), [process.execPath]);
});

test('default filesystem checks reject missing files and directories, and preserve an executable path exactly', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab browser discovery '));
  const executable = path.join(directory, 'browser with spaces');
  try {
    assert.throws(() => discover({ env: { LAB_BROWSER: executable } }), /LAB_BROWSER/);
    assert.throws(() => discover({ env: { LAB_BROWSER: directory } }), /LAB_BROWSER/);
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    assert.deepEqual(discover({ env: { LAB_BROWSER: executable } }), [executable]);
    if (process.platform !== 'win32') {
      chmodSync(executable, 0o644);
      assert.throws(() => discover({ env: { LAB_BROWSER: executable } }), /LAB_BROWSER/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
