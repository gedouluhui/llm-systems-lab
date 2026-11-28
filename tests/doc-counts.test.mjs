import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX_FILES = [
  'scripts/check-doc-counts.mjs',
  'src/version.ts',
  'package.json',
  'package-lock.json',
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'artifacts/verify-receipt.json',
  'artifacts/a2/e2e.json',
  'tests/fixtures/reference.json',
];

function makeSandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'llm-systems-lab-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const relative of SANDBOX_FILES) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ROOT, relative), target);
  }
  return root;
}

function runChecker(root, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-doc-counts.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function requireSuccess(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

function writeJson(root, relative, value) {
  writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
}

const PUBLIC_DOCS = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];

test('version:sync propagates a canonical-only version bump to every public projection', (t) => {
  const root = makeSandbox(t);
  const versionFile = path.join(root, 'src/version.ts');
  writeFileSync(versionFile, readFileSync(versionFile, 'utf8').replace('0.1.0-a1', '0.1.0-a2'));

  const before = PUBLIC_DOCS.map((relative) => readFileSync(path.join(root, relative), 'utf8'));
  const rejected = runChecker(root);
  assert.notEqual(rejected.status, 0, 'check mode must reject a canonical-only version bump');
  assert.deepEqual(
    PUBLIC_DOCS.map((relative) => readFileSync(path.join(root, relative), 'utf8')),
    before,
    'check mode must not rewrite documentation',
  );

  requireSuccess(runChecker(root, '--write'));
  assert.equal(readJson(root, 'package.json').version, '0.1.0-a2');
  assert.equal(readJson(root, 'package-lock.json').version, '0.1.0-a2');
  assert.equal(readJson(root, 'package-lock.json').packages[''].version, '0.1.0-a2');
  for (const relative of PUBLIC_DOCS) {
    const text = readFileSync(path.join(root, relative), 'utf8');
    assert.ok(text.includes('0.1.0-a2'), `${relative} must contain the new canonical version`);
    assert.ok(!text.includes('0.1.0-a1'), `${relative} must not retain the old version`);
  }
  requireSuccess(runChecker(root));
});

test('docs:check rejects a stale count outside the generated evidence block and version:sync repairs it', (t) => {
  const root = makeSandbox(t);
  const readme = path.join(root, 'README.md');
  const source = readFileSync(readme, 'utf8');
  const stale = source.replace('# 231 tests, including', '# 230 tests, including');
  assert.notEqual(stale, source, 'the quickstart count fixture must change');
  writeFileSync(readme, stale);

  const rejected = runChecker(root);
  assert.notEqual(rejected.status, 0, 'a stale quickstart count must fail even when the evidence block is current');
  assert.match(rejected.stderr, /public count claim/i);

  requireSuccess(runChecker(root, '--write'));
  assert.ok(readFileSync(readme, 'utf8').includes('# 231 tests, including'));
  requireSuccess(runChecker(root));
});

test('version:sync updates all public claims after receipt counts change', (t) => {
  const root = makeSandbox(t);
  const receipt = readJson(root, 'artifacts/verify-receipt.json');
  const nextCounts = {
    'typescript-tests': [/22 files, 231\/231 tests passed/, '22 files, 232/232 tests passed'],
    'web-tests': [/4 files, 23\/23 web tests passed/, '4 files, 24/24 web tests passed'],
    'python-reference-tests': [/18 tests passed/, '19 tests passed'],
    'source-mutation': [/11\/11 mutants caught/, '12/12 mutants caught'],
  };
  for (const stage of receipt.stages) {
    if (nextCounts[stage.name]) {
      const [pattern, detail] = nextCounts[stage.name];
      assert.match(stage.detail, pattern);
      stage.detail = stage.detail.replace(pattern, detail);
    }
  }
  writeJson(root, 'artifacts/verify-receipt.json', receipt);

  const e2e = readJson(root, 'artifacts/a2/e2e.json');
  const extra = structuredClone(e2e.results.at(-1));
  extra.name = `${extra.name}-extra`;
  e2e.requested.push(extra.name);
  e2e.executed.push(extra.name);
  e2e.results.push(extra);
  writeJson(root, 'artifacts/a2/e2e.json', e2e);

  const rejected = runChecker(root);
  assert.notEqual(rejected.status, 0, 'changed receipt counts must make the old public claims stale');
  requireSuccess(runChecker(root, '--write'));

  const en = readFileSync(path.join(root, 'README.md'), 'utf8');
  const zh = readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
  for (const claim of [
    '# 232 tests, including the 130-case',
    '# 232 个测试，含 130 用例',
    '# 19 个 NumPy 自测',
    '# 12/12 变异体被抓住',
    '12 个变异体全部被指定测试抓住',
    'E2E：21 个场景，使用隔离的临时浏览器配置',
    '# 21 browser scenarios',
    'TypeScript tests (232), web tests (24 across four files)',
    'TypeScript 测试（串行，232 个）',
    'Web 测试（4 个文件、24 个用例；',
    'a twelve-mutant source-mutation check',
    'Evidence includes 232/232 TypeScript tests with a 130-case independent NumPy fixture, 24/24 web tests, 19/19 Python tests, 12/12 mutants, and 21/21 browser E2E sections.',
  ]) {
    assert.ok(en.includes(claim), `README.md must update public claim: ${claim}; got ${en.match(/TypeScript tests[^\n]+/)?.[0] ?? 'no verification prose'}`);
  }
  for (const claim of [
    '证据包括 232/232 项 TypeScript 测试及 130 个独立 NumPy fixture 用例、24/24 项 Web 测试、19/19 项 Python 测试、12/12 个变异体、21/21 个浏览器 E2E 场景',
  ]) {
    assert.ok(zh.includes(claim), `README.zh-CN.md must update public claim: ${claim}; got ${zh.match(/npm test[^\n]+/)?.[0] ?? 'no quickstart'}`);
  }
  assert.ok(!en.includes('# 231 tests'));
  assert.ok(!en.includes('# 20 browser scenarios'));
  assert.ok(!en.includes('E2E：20 个场景'));
  assert.ok(!en.includes('# 20 browser scenarios'));
  requireSuccess(runChecker(root));
});

test('version:sync derives fixture counts instead of hard-coding them', (t) => {
  const root = makeSandbox(t);
  const fixture = readJson(root, 'tests/fixtures/reference.json');
  fixture.cases.push(structuredClone(fixture.cases[0]));
  writeJson(root, 'tests/fixtures/reference.json', fixture);

  const rejected = runChecker(root);
  assert.notEqual(rejected.status, 0, 'a changed fixture count must make current public claims stale');
  requireSuccess(runChecker(root, '--write'));

  const en = readFileSync(path.join(root, 'README.md'), 'utf8');
  const zh = readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
  assert.ok(en.includes('131-case independent NumPy fixture'));
  assert.ok(zh.includes('131 个独立 NumPy fixture 用例'));
  assert.ok(!en.includes('130-case independent NumPy fixture'));
  requireSuccess(runChecker(root));
});
