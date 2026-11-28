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
const typescriptDetail = requiredStage(receipt, 'typescript-tests');
const webDetail = requiredStage(receipt, 'web-tests');
const counts = {
  typescript: ratio(typescriptDetail, /(\d+)\/(\d+) tests passed/, 'TypeScript tests'),
  web: ratio(webDetail, /(\d+)\/(\d+) web tests passed/, 'web tests'),
  python: ratio(requiredStage(receipt, 'python-reference-tests'), /^(\d+) tests passed$/, 'Python tests'),
  mutants: ratio(requiredStage(receipt, 'source-mutation'), /(\d+)\/(\d+) mutants caught/, 'mutants'),
  fixture: JSON.parse(read('tests/fixtures/reference.json')).cases?.length,
  webFiles: Number(/^(\d+) files,/.exec(webDetail)?.[1]),
  stages: receipt.stages.length,
};
assert.ok(Number.isInteger(counts.fixture) && counts.fixture > 0, 'reference fixture count must be a positive integer');
assert.ok(Number.isInteger(counts.webFiles) && counts.webFiles > 0, 'web test file count must be a positive integer');
assert.ok(Number.isInteger(counts.stages) && counts.stages > 0, 'verification stage count must be a positive integer');
const e2e = JSON.parse(read('artifacts/a2/e2e.json'));
assert.equal(e2e.ok, true, 'browser E2E receipt must pass');
assert.equal(e2e.full, true, 'browser E2E must be full');
assert.deepEqual(e2e.executed, e2e.requested, 'browser E2E must execute every requested section');
assert.equal(e2e.results.length, e2e.requested.length, 'browser E2E result count must match requested sections');
assert.ok(e2e.results.every((result) => result.ok), 'every browser E2E section must pass');
counts.e2e = e2e.results.length;

const evidence = {
  en: `Evidence includes ${counts.typescript}/${counts.typescript} TypeScript tests with a ${counts.fixture}-case independent NumPy fixture, ${counts.web}/${counts.web} web tests, ${counts.python}/${counts.python} Python tests, ${counts.mutants}/${counts.mutants} mutants, and ${counts.e2e}/${counts.e2e} browser E2E sections. These are regression and integration checks for the frozen tiny-decoder contract, not a proof for all inputs or a measure of model quality.`,
  zh: `证据包括 ${counts.typescript}/${counts.typescript} 项 TypeScript 测试及 ${counts.fixture} 个独立 NumPy fixture 用例、${counts.web}/${counts.web} 项 Web 测试、${counts.python}/${counts.python} 项 Python 测试、${counts.mutants}/${counts.mutants} 个变异体、${counts.e2e}/${counts.e2e} 个浏览器 E2E 场景，以及 scripts/verify.mjs ${chineseNumber(counts.stages)}阶段总验收。这些是冻结的小型解码器契约的回归与集成证据，不是对所有输入的证明，也不是模型质量测量。`,
};

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function numberWord(value) {
  return NUMBER_WORDS[value] ?? String(value);
}

function chineseNumber(value) {
  const digits = '零一二三四五六七八九';
  if (value < 10) return digits[value];
  if (value === 10) return '十';
  if (value < 20) return `十${digits[value - 10]}`;
  if (value < 100) return `${digits[Math.floor(value / 10)]}十${value % 10 === 0 ? '' : digits[value % 10]}`;
  return String(value);
}

function ratioCount(value) {
  return `${value}/${value}`;
}

function syncPublicCounts(relative, source) {
  let updated = source;
  const changes = [];
  const replace = (pattern, render) => {
    updated = updated.replace(pattern, (...args) => {
      const match = args[0];
      const replacement = render(...args);
      if (replacement !== match) {
        const line = updated.slice(0, args.at(-2)).split('\n').at(-1);
        changes.push(`${line}${match} -> ${replacement}`);
      }
      return replacement;
    });
  };

  // Keep receipt-derived counts synchronized wherever they are described,
  // not just inside the generated evidence block.
  replace(/(\d+)(?:\/(\d+))?(?= (?:TypeScript )?tests?\b)/g,
    (match, count, total) => total === undefined ? String(counts.typescript) : ratioCount(counts.typescript));
  replace(/(\d+)(?:\/(\d+))?(?= web tests\b)/g,
    (match, count, total) => total === undefined ? String(counts.web) : ratioCount(counts.web));
  replace(/(\d+)(?:\/(\d+))?(?= Python tests\b)/g,
    (match, count, total) => total === undefined ? String(counts.python) : ratioCount(counts.python));
  replace(/(\d+)(?:\/(\d+))?(?= mutants\b)/g,
    (match, count, total) => total === undefined ? String(counts.mutants) : ratioCount(counts.mutants));
  replace(/(\d+)(?= (?:browser scenarios|browser E2E sections)\b)/g, () => String(counts.e2e));
  replace(/(\d+)(?= NumPy self-tests\b)/g, () => String(counts.python));
  replace(/(\d+)(?= reserved cases\b)/g, () => String(counts.fixture));
  replace(/(\d+)(?= cases\b)/g, () => String(counts.fixture));
  replace(/(\d+)(?=-case\b)/g, () => String(counts.fixture));
  replace(/\b(a|an) (\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)-mutant\b/g,
    () => `${['eight', 'eleven', 'eighteen'].includes(numberWord(counts.mutants)) ? 'an' : 'a'} ${numberWord(counts.mutants)}-mutant`);
  replace(/(TypeScript tests \()(\d+)(?=\))/g, (match, prefix) => `${prefix}${counts.typescript}`);
  replace(/(web tests \()(\d+)( across )[a-z0-9]+( files\))/g,
    (match, prefix, count, middle, suffix) => `${prefix}${counts.web}${middle}${numberWord(counts.webFiles)}${suffix}`);
  replace(/\b(?:eight|\d+) stages\b/g, () => `${numberWord(counts.stages)} stages`);

  replace(/(\d+)(?:\/(\d+))?( 项 )(TypeScript|Web|Python)( 测试)/g,
    (match, count, total, separator, language, suffix) => {
      const value = { TypeScript: counts.typescript, Web: counts.web, Python: counts.python }[language];
      return `${total === undefined ? value : ratioCount(value)}${separator}${language}${suffix}`;
    });
  replace(/(TypeScript 测试（串行，)(\d+)( 个）)/g,
    (match, prefix, count, suffix) => `${prefix}${counts.typescript}${suffix}`);
  replace(/(Web 测试（)(\d+)( 个文件、)(\d+)( 个用例；)/g,
    (match, prefix, files, middle, tests, suffix) => `${prefix}${counts.webFiles}${middle}${counts.web}${suffix}`);
  replace(/(\d+)(?= 个测试)/g, () => String(counts.typescript));
  replace(/(\d+)(?:\/(\d+))?(?= 变异体)/g,
    (match, count, total) => total === undefined ? String(counts.mutants) : ratioCount(counts.mutants));
  replace(/(\d+)(?= 个变异体)/g, () => String(counts.mutants));
  replace(/(\d+)(?= 个浏览器 E2E 场景)/g, () => String(counts.e2e));
  replace(/(\d+)(?= 个 NumPy 自测)/g, () => String(counts.python));
  replace(/(\d+)(?= 个独立 NumPy fixture 用例)/g, () => String(counts.fixture));
  replace(/(\d+)(?= 用例)/g, () => String(counts.fixture));
  replace(/(\d+)(?= 个用例是回归证据)/g, () => String(counts.fixture));
  replace(/(\d+)(?= 个场景)/g, () => String(counts.e2e));
  replace(/(?:八|\d+)阶段/g, () => `${chineseNumber(counts.stages)}阶段`);

  if (!WRITE) {
    assert.equal(updated, source, `${relative} has stale public count claims; run npm run version:sync:\n${changes.join('\n')}`);
  }
  return updated;
}

function syncBlock(relative, language, source = read(relative)) {
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

const publicDocs = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const previousVersion = pkg.version;

// Write mode starts from the canonical source. In particular, do not require
// READMEs to already contain a version that has only changed in src/version.ts.
if (WRITE) {
  if (pkg.version !== version) {
    pkg.version = version;
    write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    lock.version = version;
    lock.packages[''].version = version;
    write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  }
}

const documents = Object.fromEntries(publicDocs.map((relative) => [
  relative,
  WRITE ? read(relative).replaceAll(previousVersion, version) : read(relative),
]));
for (const [relative, language] of [['README.md', 'en'], ['README.zh-CN.md', 'zh']]) {
  const withCounts = syncPublicCounts(relative, documents[relative]);
  documents[relative] = syncBlock(relative, language, withCounts);
}

if (WRITE) {
  for (const [relative, text] of Object.entries(documents)) {
    if (text !== read(relative)) write(relative, text);
  }
} else {
  assert.equal(pkg.version, version, 'package.json version differs from src/version.ts');
  assert.equal(lock.version, version, 'package-lock.json version differs from src/version.ts');
  assert.equal(lock.packages?.['']?.version, version, 'package-lock root version differs from src/version.ts');
  for (const relative of publicDocs) {
    assert.ok(documents[relative].includes(version), `${relative} must document version ${version}`);
  }
}

console.log(`docs: OK (version ${version}; TypeScript ${counts.typescript}, web ${counts.web}, Python ${counts.python}, mutants ${counts.mutants}, E2E ${counts.e2e})`);
