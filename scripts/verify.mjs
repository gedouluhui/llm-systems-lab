#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb, WEB_MAX_BYTES } from './build-web.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARTIFACTS = path.join(PROJECT_ROOT, 'artifacts');
const PACK_DIR = path.join(ARTIFACTS, 'pack');
const RECEIPT = path.join(ARTIFACTS, 'verify-receipt.json');
const PYTHON = process.env.PYTHON ?? 'python';
const TSC = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const DEFAULT_TIMEOUT = 600000;
const MIN_TYPESCRIPT_TESTS = 93;
const MIN_WEB_TESTS = 17;
const MIN_PYTHON_TESTS = 18;
const EXPECTED_MUTANTS = [
  'position-offset-disabled',
  'cache-overwrite-disabled',
  'mask-current-only-disabled',
  'comparison-always-pass',
  'paging-floor-instead-of-ceil',
  'seed-bounds-skipped',
];

const evidence = Object.create(null);

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isolatedRuntimeEnv(emptyPath) {
  const env = { PATH: emptyPath };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  }
  return env;
}

function resolveNpm() {
  const candidates = [];
  const execpath = process.env.npm_execpath;
  if (typeof execpath === 'string' && path.basename(execpath) === 'npm-cli.js') {
    candidates.push(execpath);
  }
  const nodeDir = path.dirname(process.execPath);
  candidates.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { command: process.execPath, prefix: [candidate] };
    }
  }
  const probe = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (probe.status === 0) {
    return { command: 'npm', prefix: [] };
  }
  return null;
}

function requireOutsideProject(target, label) {
  const relative = path.relative(PROJECT_ROOT, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the project, got ${target}`);
  }
}

function runProcess(command, args, options = {}) {
  let env;
  if (options.isolated === true) {
    env = { ...(options.env ?? {}) };
  } else {
    env = { ...process.env, ...(options.env ?? {}) };
    delete env.NODE_TEST_CONTEXT;
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    windowsHide: true,
    env,
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function tailLines(text, count) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-count).join('\n');
}

function describe(result) {
  if (result.status === null) {
    const code = result.error === undefined ? 'UNKNOWN' : result.error.code ?? result.error.message;
    return `spawn error ${String(code)}`;
  }
  if (result.signal !== null) {
    return `signal ${String(result.signal)}`;
  }
  return `exit ${String(result.status)}`;
}

function requireSuccess(result, label) {
  if (result.status === 0) {
    return;
  }
  const diagnostic = tailLines(`${result.stderr}\n${result.stdout}`.trim(), 12);
  throw new Error(`${label} failed (${describe(result)})${diagnostic.length > 0 ? `\n${diagnostic}` : ''}`);
}

function parseJsonLine(text, label) {
  const line = text.split(/\r?\n/).filter((entry) => entry.length > 0).pop();
  if (line === undefined) {
    throw new Error(`${label} printed no output`);
  }
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${label} did not print valid JSON`);
  }
}

function stageBuild() {
  requireSuccess(
    runProcess(process.execPath, [TSC, '-p', 'tsconfig.json']),
    'TypeScript build',
  );
  return { detail: 'tsc exit 0' };
}

function stageWebBuild() {
  const budget = process.env.WEB_MAX_BYTES === undefined
    ? WEB_MAX_BYTES
    : Number(process.env.WEB_MAX_BYTES);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('WEB_MAX_BYTES must be a positive number');
  }
  const result = buildWeb();
  if (result.totalBytes > budget) {
    throw new Error(`web build is ${result.totalBytes} bytes, above the ${budget} byte budget`);
  }
  const shell = readFileSync(path.join(PROJECT_ROOT, 'apps', 'web', 'dist', 'index.html'), 'utf8');
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    if (!shell.includes(directive)) {
      throw new Error(`web shell is missing CSP directive: ${directive}`);
    }
  }
  if (/(?:src|href)="(?:https?:)?\/\//i.test(shell)) {
    throw new Error('web shell references an absolute URL');
  }
  evidence.web = { bytes: result.totalBytes, files: result.files.length, tests: null };
  return {
    detail: `${result.files.length} files, ${result.totalBytes} bytes, CSP present`,
    lines: [`web bytes: ${result.totalBytes} of ${budget}`],
  };
}

function parseTapSummary(stdout) {
  const summary = Object.create(null);
  for (const match of stdout.matchAll(/^# ([a-z]+) (\d+)$/gm)) {
    summary[match[1]] = Number(match[2]);
  }
  return summary;
}

function stageTests() {
  const testsDir = path.join(PROJECT_ROOT, 'tests');
  const files = readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('tests', name));
  if (files.length === 0) {
    throw new Error('no *.test.mjs files found under tests/');
  }
  const result = runProcess(process.execPath, [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    ...files,
  ]);
  requireSuccess(result, 'TypeScript tests');
  const summary = parseTapSummary(result.stdout);
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    if (!Number.isInteger(summary[key])) {
      throw new Error(`TypeScript test summary is missing "# ${key}"`);
    }
  }
  if (summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0) {
    throw new Error(
      `TypeScript tests are not clean (fail=${summary.fail}, cancelled=${summary.cancelled}, `
        + `skipped=${summary.skipped}, todo=${summary.todo})`,
    );
  }
  if (summary.pass !== summary.tests) {
    throw new Error(`TypeScript test totals disagree (pass=${summary.pass}, tests=${summary.tests})`);
  }
  if (summary.tests < MIN_TYPESCRIPT_TESTS) {
    throw new Error(
      `TypeScript test count dropped to ${summary.tests}, expected at least ${MIN_TYPESCRIPT_TESTS}`,
    );
  }
  return { detail: `${files.length} files, ${summary.pass}/${summary.tests} tests passed` };
}

function stageWebTests() {
  const testsDir = path.join(PROJECT_ROOT, 'tests');
  const files = readdirSync(testsDir)
    .filter((name) => name.startsWith('web-') && name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('tests', name));
  if (files.length === 0) {
    throw new Error('no web-*.test.mjs files found under tests/; refusing to pass an empty web suite');
  }
  const result = runProcess(process.execPath, [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    ...files,
  ]);
  requireSuccess(result, 'web tests');
  const summary = parseTapSummary(result.stdout);
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    if (!Number.isInteger(summary[key])) {
      throw new Error(`web test summary is missing "# ${key}"`);
    }
  }
  if (summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0 || summary.todo !== 0) {
    throw new Error(
      `web tests are not clean (fail=${summary.fail}, cancelled=${summary.cancelled}, `
        + `skipped=${summary.skipped}, todo=${summary.todo})`,
    );
  }
  if (summary.pass !== summary.tests) {
    throw new Error(`web test totals disagree (pass=${summary.pass}, tests=${summary.tests})`);
  }
  if (summary.tests < files.length || summary.tests < MIN_WEB_TESTS) {
    throw new Error(
      `web test count dropped to ${summary.tests} across ${files.length} files, expected at least ${MIN_WEB_TESTS}`,
    );
  }
  if (evidence.web === undefined) {
    throw new Error('web build stage did not record bundle evidence');
  }
  evidence.web.tests = summary.tests;
  return { detail: `${files.length} files, ${summary.pass}/${summary.tests} web tests passed` };
}

function stagePython() {
  const result = runProcess(
    PYTHON,
    ['-m', 'unittest', 'discover', '-s', 'reference', '-p', 'test_*.py'],
    { cwd: PROJECT_ROOT },
  );
  requireSuccess(result, 'Python reference tests');
  const ran = /^Ran (\d+) tests?/m.exec(result.stderr);
  if (ran === null) {
    throw new Error('Python unittest summary is missing "Ran N tests"');
  }
  if (!/^OK$/m.test(result.stderr)) {
    throw new Error('Python unittest did not report a clean "OK"; skips are not accepted');
  }
  const count = Number(ran[1]);
  if (count < MIN_PYTHON_TESTS) {
    throw new Error(`Python test count dropped to ${count}, expected at least ${MIN_PYTHON_TESTS}`);
  }
  return { detail: `${count} tests passed` };
}

function stageProvenance() {
  const fixturePath = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'reference.json');
  if (!existsSync(fixturePath)) {
    throw new Error('tests/fixtures/reference.json is missing');
  }
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch {
    throw new Error('reference fixture is not valid JSON');
  }
  if (fixture.schemaVersion !== 1) {
    throw new Error(`unexpected fixture schemaVersion ${String(fixture.schemaVersion)}`);
  }
  if (fixture.modelId !== 'tiny-decoder-v1') {
    throw new Error(`unexpected fixture modelId ${String(fixture.modelId)}`);
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== 130) {
    throw new Error('fixture must contain exactly 130 cases');
  }
  const provenance = fixture.provenance;
  if (typeof provenance !== 'object' || provenance === null) {
    throw new Error('fixture provenance is missing');
  }
  const decoderPath = path.join(PROJECT_ROOT, 'reference', 'decoder.py');
  const generatorPath = path.join(PROJECT_ROOT, 'reference', 'generate_cases.py');
  for (const file of [decoderPath, generatorPath]) {
    if (!existsSync(file)) {
      throw new Error(`${path.relative(PROJECT_ROOT, file)} is missing`);
    }
  }
  const decoderSha256 = sha256File(decoderPath);
  const generatorSha256 = sha256File(generatorPath);
  if (decoderSha256 !== provenance.decoderSha256) {
    throw new Error('reference/decoder.py digest does not match fixture provenance');
  }
  if (generatorSha256 !== provenance.generatorSha256) {
    throw new Error('reference/generate_cases.py digest does not match fixture provenance');
  }
  const sources = ['packages/core/experiment.ts', 'packages/core/decoder.ts', 'src/cli.ts'];
  const sourceHashes = Object.create(null);
  for (const relative of sources) {
    const file = path.join(PROJECT_ROOT, relative);
    if (!existsSync(file)) {
      throw new Error(`${relative} is missing`);
    }
    sourceHashes[relative] = sha256File(file);
  }
  evidence.hashes = {
    fixture: sha256File(fixturePath),
    decoder: decoderSha256,
    generator: generatorSha256,
    sources: sourceHashes,
  };
  return {
    detail: '130 cases, provenance matches',
    lines: [
      `fixture sha256: ${evidence.hashes.fixture}`,
      `reference/decoder.py sha256: ${decoderSha256}`,
      `reference/generate_cases.py sha256: ${generatorSha256}`,
      `recorded reference runtime: Python ${String(provenance.pythonVersion)}, NumPy ${String(provenance.numpyVersion)}`,
    ],
  };
}

function stageMutation() {
  const result = runProcess(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'mutation-check.mjs')]);
  requireSuccess(result, 'mutation check');
  const verdict = /result: PASS \((\d+)\/(\d+) mutants caught\)/.exec(result.stdout);
  if (verdict === null) {
    throw new Error('mutation check did not print a PASS verdict');
  }
  const caught = Number(verdict[1]);
  const total = Number(verdict[2]);
  if (caught !== total || total < EXPECTED_MUTANTS.length) {
    throw new Error(
      `mutation check caught ${caught} of ${total} mutants, expected at least ${EXPECTED_MUTANTS.length} and no misses`,
    );
  }
  const statuses = Object.create(null);
  for (const match of result.stdout.matchAll(/^- ([a-z0-9-]+): ([A-Z]+)/gm)) {
    statuses[match[1]] = match[2];
  }
  for (const name of EXPECTED_MUTANTS) {
    if (statuses[name] !== 'CAUGHT') {
      throw new Error(`expected mutant ${name} was not reported as CAUGHT (got ${String(statuses[name])})`);
    }
  }
  evidence.mutation = { caught, total };
  return { detail: `${caught}/${total} mutants caught, all ${EXPECTED_MUTANTS.length} required names present` };
}

function requireEntry(entries, required, label) {
  if (!entries.includes(required)) {
    throw new Error(`${label} is missing from the packed tarball`);
  }
}

function validateTarballEntries(entries) {
  const allowedTop = new Set(['package.json', 'README.md', 'LICENSE', 'dist']);
  const forbidden = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|kaggle\.json|id_rsa|credentials\.json|node_modules)(?:\/|$)/i;
  for (const entry of entries) {
    if (entry === 'package' || entry === 'package/') {
      continue;
    }
    if (!entry.startsWith('package/')) {
      throw new Error(`packed entry escapes the package root: ${entry}`);
    }
    const relative = entry.slice('package/'.length);
    const isDirectory = relative.endsWith('/');
    const segments = (isDirectory ? relative.slice(0, -1) : relative).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`packed entry has an unsafe path segment: ${entry}`);
    }
    const top = segments[0];
    if (!allowedTop.has(top)) {
      throw new Error(`packed entry is not part of the runtime distribution: ${entry}`);
    }
    if (top === 'dist' && !isDirectory) {
      const name = segments[segments.length - 1];
      if (!name.endsWith('.js') && !name.endsWith('.d.ts')) {
        throw new Error(`dist entry is neither JavaScript nor a declaration file: ${entry}`);
      }
    }
    if (forbidden.test(entry)) {
      throw new Error(`packed entry looks private or generated: ${entry}`);
    }
  }
  for (const required of [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist/src/cli.js',
    'package/dist/packages/core/index.js',
    'package/dist/packages/simulator/index.js',
  ]) {
    requireEntry(entries, required, required);
  }
}

function stagePack() {
  for (const file of ['README.md', 'LICENSE']) {
    if (!existsSync(path.join(PROJECT_ROOT, file))) {
      throw new Error(`${file} is required before packing`);
    }
  }
  rmSync(PACK_DIR, { recursive: true, force: true });
  mkdirSync(PACK_DIR, { recursive: true });
  const npm = resolveNpm();
  if (npm === null) {
    throw new Error('could not resolve the npm CLI from npm_execpath, the Node installation, or PATH');
  }

  const pack = runProcess(npm.command, [
    ...npm.prefix,
    'pack',
    '--json',
    '--pack-destination',
    PACK_DIR,
  ]);
  requireSuccess(pack, 'npm pack');

  let report;
  try {
    report = JSON.parse(pack.stdout);
  } catch {
    throw new Error('npm pack did not return JSON');
  }
  const packed = Array.isArray(report) ? report[0] : report;
  if (packed === undefined || typeof packed.filename !== 'string') {
    throw new Error('npm pack did not report a tarball filename');
  }
  const tarball = path.isAbsolute(packed.filename)
    ? packed.filename
    : path.join(PACK_DIR, packed.filename);
  if (!existsSync(tarball)) {
    throw new Error(`packed tarball does not exist: ${tarball}`);
  }
  if (path.resolve(path.dirname(tarball)) !== path.resolve(PACK_DIR)) {
    throw new Error('npm pack wrote the tarball outside the expected pack directory');
  }

  const tarballName = path.basename(tarball);
  const tarLocal = process.platform === 'win32' ? ['--force-local'] : [];
  const listing = runProcess('tar', [...tarLocal, '-tzf', tarballName], { cwd: PACK_DIR });
  requireSuccess(listing, 'tarball listing');
  const entries = listing.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll('\\', '/'))
    .filter((entry) => entry.length > 0);
  validateTarballEntries(entries);

  const extractRoot = mkdtempSync(path.join(tmpdir(), 'llm-systems-lab-pack-'));
  const emptyPath = mkdtempSync(path.join(tmpdir(), 'llm-systems-lab-path-'));
  try {
    requireOutsideProject(extractRoot, 'packed extraction directory');
    requireOutsideProject(emptyPath, 'isolated PATH directory');
    requireSuccess(
      runProcess('tar', [...tarLocal, '-xzf', tarball, '-C', extractRoot]),
      'tarball extraction',
    );
    const packageRoot = path.join(extractRoot, 'package');
    for (const sourceDir of ['reference', 'tests', 'src', 'scripts', 'docs', '.superpowers', 'node_modules']) {
      if (existsSync(path.join(packageRoot, sourceDir))) {
        throw new Error(
          `packed artifact ships ${sourceDir}/, so the smoke test would not prove source independence`,
        );
      }
    }
    const packedJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (packedJson.name !== 'llm-systems-lab') {
      throw new Error(`unexpected packed package name ${String(packedJson.name)}`);
    }
    if (packedJson.dependencies !== undefined
      || packedJson.optionalDependencies !== undefined
      || packedJson.peerDependencies !== undefined) {
      throw new Error('packed package must not have runtime dependencies');
    }
    if (packedJson.bin?.['llm-systems-lab'] !== 'dist/src/cli.js') {
      throw new Error('packed package bin entry is missing or points elsewhere');
    }

    const demo = runProcess(process.execPath, ['dist/src/cli.js', 'demo'], {
      cwd: packageRoot,
      timeout: 120000,
      isolated: true,
      env: isolatedRuntimeEnv(emptyPath),
    });
    requireSuccess(demo, 'packed CLI demo');
    if (!demo.stdout.includes('result: PASS')) {
      throw new Error('packed CLI demo did not report a PASS result');
    }

    const normal = runProcess(
      process.execPath,
      ['dist/src/cli.js', 'run', '--seed', '7', '--tokens', '1,4,2'],
      {
        cwd: packageRoot,
        timeout: 120000,
        isolated: true,
        env: isolatedRuntimeEnv(emptyPath),
      },
    );
    requireSuccess(normal, 'packed CLI run');
    const normalReport = parseJsonLine(normal.stdout, 'packed CLI run');
    if (normalReport.comparison?.passes !== true) {
      throw new Error('packed CLI run did not report numerical agreement');
    }

    const fault = runProcess(
      process.execPath,
      ['dist/src/cli.js', 'run', '--seed', '7', '--tokens', '1,4,2', '--fault', 'cache-overwrite'],
      {
        cwd: packageRoot,
        timeout: 120000,
        isolated: true,
        env: isolatedRuntimeEnv(emptyPath),
      },
    );
    if (fault.status !== 1) {
      throw new Error(`packed CLI fault run must exit 1, got ${describe(fault)}`);
    }
    const faultReport = parseJsonLine(fault.stdout, 'packed CLI fault run');
    if (faultReport.comparison?.passes !== false || faultReport.comparison.firstDivergence === null) {
      throw new Error('packed CLI fault run did not report a divergence');
    }
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(emptyPath, { recursive: true, force: true });
  }

  evidence.pack = {
    filename: path.basename(tarball),
    bytes: statSync(tarball).size,
    sha256: sha256File(tarball),
    entries: entries.length,
  };
  return {
    detail: `${path.basename(tarball)}, ${String(entries.length)} entries, packed CLI passes in isolation`,
    lines: [
      `tarball sha256: ${evidence.pack.sha256}`,
      'extracted outside the project; no reference/, tests/, src/, scripts/, docs/ or node_modules/',
      'packed CLI ran with PATH pointing at an empty temporary directory',
      'packed CLI ran demo, passing run, and diverging fault run',
    ],
  };
}

const STAGES = [
  { name: 'build', execute: stageBuild },
  { name: 'web-build', execute: stageWebBuild },
  { name: 'typescript-tests', execute: stageTests },
  { name: 'web-tests', execute: stageWebTests },
  { name: 'python-reference-tests', execute: stagePython },
  { name: 'fixture-provenance', execute: stageProvenance },
  { name: 'source-mutation', execute: stageMutation },
  { name: 'packed-artifact', execute: stagePack },
];

function writeReceipt(stages, skipped) {
  const receipt = {
    schemaVersion: 1,
    ok: skipped.length === 0 && stages.every((stage) => stage.ok),
    stages,
    skipped,
    hashes: evidence.hashes ?? null,
    web: evidence.web ?? null,
    mutation: evidence.mutation ?? null,
    pack: evidence.pack ?? null,
  };
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function main() {
  console.log('llm-systems-lab verification gate');
  console.log(`project root: ${PROJECT_ROOT}`);
  console.log('rule: every stage must succeed; missing components fail instead of being skipped');

  const stages = [];
  let skipped = [];
  for (let index = 0; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    process.stdout.write(`[${index + 1}/${STAGES.length}] ${stage.name} ... `);
    try {
      const outcome = stage.execute();
      stages.push({ name: stage.name, ok: true, detail: outcome.detail });
      process.stdout.write(`PASS (${outcome.detail})\n`);
      for (const line of outcome.lines ?? []) {
        console.log(`    ${line}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stages.push({ name: stage.name, ok: false, detail: message });
      process.stdout.write('FAIL\n');
      console.error(`    ${message.split('\n').join('\n    ')}`);
      skipped = STAGES.slice(index + 1).map((entry) => entry.name);
      break;
    }
  }

  const receipt = writeReceipt(stages, skipped);
  const passed = stages.filter((stage) => stage.ok).length;
  console.log(`receipt: ${path.relative(PROJECT_ROOT, RECEIPT)}`);
  console.log(`result: ${receipt.ok ? 'PASS' : 'FAIL'} (${passed}/${STAGES.length} stages passed)`);
  return receipt.ok ? 0 : 1;
}

process.exitCode = main();
