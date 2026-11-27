#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WRITE = process.argv.includes('--write');
const START = '<!-- verification-evidence:start -->';
const END = '<!-- verification-evidence:end -->';

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
}

function write(relative, text) {
  writeFileSync(path.join(ROOT, relative), text);
}

function requiredStage(receipt, name) {
  const stage = receipt.stages?.find((entry) => entry.name === name);
  assert.ok(stage?.ok, `verification stage ${name} must pass`);
  return stage.detail;
}

function ratio(detail, pattern, label) {
  const match = pattern.exec(detail);
  assert.ok(match, `${label} is missing from verification detail: ${detail}`);
  if (match[2] !== undefined) {
    assert.equal(match[1], match[2], `${label} must be a clean pass: ${detail}`);
  }
  return Number(match[2] ?? match[1]);
}

const versionSource = read('src/version.ts');
const versionMatch = /export const ENGINE_VERSION = '([^']+)';/.exec(versionSource);
assert.ok(versionMatch, 'src/version.ts must export a literal ENGINE_VERSION');
const version = versionMatch[1];

const receipt = JSON.parse(read('artifacts/verify-receipt.json'));
assert.equal(receipt.ok, true, 'verification receipt must pass');
const counts = {
  typescript: ratio(requiredStage(receipt, 'typescript-tests'), /(\d+)\/(\d+) tests passed/, 'TypeScript tests'),
  web: ratio(requiredStage(receipt, 'web-tests'), /(\d+)\/(\d+) web tests passed/, 'web tests'),
  python: ratio(requiredStage(receipt, 'python-reference-tests'), /^(\d+) tests passed$/, 'Python tests'),
  mutants: ratio(requiredStage(receipt, 'source-mutation'), /(\d+)\/(\d+) mutants caught/, 'mutants'),
};
const e2e = JSON.parse(read('artifacts/a2/e2e.json'));
assert.equal(e2e.ok, true, 'browser E2E receipt must pass');
assert.equal(e2e.full, true, 'browser E2E must be full');
assert.deepEqual(e2e.executed, e2e.requested, 'browser E2E must execute every requested section');
assert.equal(e2e.results.length, e2e.requested.length, 'browser E2E result count must match requested sections');
assert.ok(e2e.results.every((result) => result.ok), 'every browser E2E section must pass');
counts.e2e = e2e.results.length;

const evidence = {
  en: `Evidence includes ${counts.typescript}/${counts.typescript} TypeScript tests with a 130-case independent NumPy fixture, ${counts.web}/${counts.web} web tests, ${counts.python}/${counts.python} Python tests, ${counts.mutants}/${counts.mutants} mutants, and ${counts.e2e}/${counts.e2e} browser E2E sections. These are regression and integration checks for the frozen tiny-decoder contract, not a proof for all inputs or a measure of model quality.`,
  zh: `证据包括 ${counts.typescript}/${counts.typescript} 项 TypeScript 测试及 130 个独立 NumPy fixture 用例、${counts.web}/${counts.web} 项 Web 测试、${counts.python}/${counts.python} 项 Python 测试、${counts.mutants}/${counts.mutants} 个变异体、${counts.e2e}/${counts.e2e} 个浏览器 E2E 场景，以及 scripts/verify.mjs 八阶段总验收。这些是冻结的小型解码器契约的回归与集成证据，不是对所有输入的证明，也不是模型质量测量。`,
};

function syncBlock(relative, language) {
  const source = read(relative);
  const block = `${START}\n${evidence[language]}\n${END}`;
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  assert.ok(start >= 0 && end > start, `${relative} must contain one generated evidence block`);
  assert.equal(source.indexOf(START, start + 1), -1, `${relative} has duplicate evidence starts`);
  const updated = WRITE ? `${source.slice(0, start)}${block}${source.slice(end + END.length)}` : source;
  if (!WRITE) {
    assert.equal(source.slice(start, end + END.length), block, `${relative} evidence is stale; run npm run version:sync`);
  }
  return updated;
}

const readmes = {
  'README.md': syncBlock('README.md', 'en'),
  'README.zh-CN.md': syncBlock('README.zh-CN.md', 'zh'),
};
for (const [relative, text] of Object.entries(readmes)) {
  assert.ok(text.includes(version), `${relative} must document version ${version}`);
}
if (WRITE) {
  for (const [relative, text] of Object.entries(readmes)) write(relative, text);

  // Keep every public version statement bound to the same source.
  const pkg = JSON.parse(read('package.json'));
  for (const relative of ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const source = read(relative);
    const updated = source.replaceAll(pkg.version, version);
    if (updated !== source) write(relative, updated);
  }
  if (pkg.version !== version) {
    pkg.version = version;
    write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const lock = JSON.parse(read('package-lock.json'));
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    lock.version = version;
    lock.packages[''].version = version;
    write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  }

  // Keep the other public version statements bound to the same source.
  for (const relative of ['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const source = read(relative);
    const updated = source.replace(/0\.1\.0-a1/g, version);
    if (updated !== source) write(relative, updated);
  }
} else {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, version, 'package.json version differs from src/version.ts');
  assert.equal(lock.version, version, 'package-lock.json version differs from src/version.ts');
  assert.equal(lock.packages?.['']?.version, version, 'package-lock root version differs from src/version.ts');
  for (const relative of ['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) {
    assert.ok(read(relative).includes(version), `${relative} must document version ${version}`);
  }
}

console.log(`docs: OK (version ${version}; TypeScript ${counts.typescript}, web ${counts.web}, Python ${counts.python}, mutants ${counts.mutants}, E2E ${counts.e2e})`);
