import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = path.join(ROOT, 'dist', 'src', 'cli.js');

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('CLI run emits JSON only and exits 0 when the comparison passes', () => {
  const result = runCli(['run', '--seed', '7', '--tokens', '1,4,2,8,3,9']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.comparison.passes, true);
  assert.equal(report.steps.length, 6);
});

test('CLI run exits 1 for numerical divergence while still emitting JSON', () => {
  const result = runCli(['run', '--seed', '7', '--tokens', '1,4,2,8,3,9', '--fault', 'cache-overwrite']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.comparison.passes, false);
  assert.equal(report.comparison.firstDivergence, 1);
});

test('CLI run rejects malformed arguments with exit code 2 and empty stdout', () => {
  const cases = [
    [],
    ['bogus'],
    ['run'],
    ['run', '--tokens', '1'],
    ['run', '--seed', '7'],
    ['run', '--seed', '-1', '--tokens', '1'],
    ['run', '--seed', '4294967296', '--tokens', '1'],
    ['run', '--seed', '7', '--tokens', ''],
    ['run', '--seed', '7', '--tokens', '1,,2'],
    ['run', '--seed', '7', '--tokens', '1,x'],
    ['run', '--seed', '7', '--tokens', '01'],
    ['run', '--seed', '7', '--tokens', '32'],
    ['run', '--seed', '7', '--tokens', '1', '--fault', 'unknown'],
    ['run', '--seed', '7', '--seed', '8', '--tokens', '1'],
    ['run', '--seed', '7', '--tokens', '1', '--extra', 'x'],
    ['run', '--seed=7', '--tokens', '1'],
    ['run', '--seed', '7', '--tokens', '1', '--fault'],
    ['run', '--seed'],
  ];
  for (const args of cases) {
    const result = runCli(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
  }
});

test('CLI replay recomputes a saved report and mirrors its comparison status', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'llm-lab-replay-'));
  try {
    const normal = runCli(['run', '--seed', '7', '--tokens', '1,4,2,8,3,9']);
    assert.equal(normal.status, 0, normal.stderr);
    const normalFile = path.join(directory, 'normal.json');
    writeFileSync(normalFile, normal.stdout);
    const replayed = runCli(['replay', normalFile]);
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(JSON.parse(replayed.stdout), JSON.parse(normal.stdout));

    const faulty = runCli(['run', '--seed', '7', '--tokens', '1,4,2,8,3,9', '--fault', 'mask-current-only']);
    assert.equal(faulty.status, 1, faulty.stderr);
    const faultyFile = path.join(directory, 'faulty.json');
    writeFileSync(faultyFile, faulty.stdout);
    const replayFaulty = runCli(['replay', faultyFile]);
    assert.equal(replayFaulty.status, 1, replayFaulty.stderr);
    assert.equal(JSON.parse(replayFaulty.stdout).comparison.passes, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI replay rejects oversized, malformed, and tampered reports with exit code 2', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'llm-lab-reject-'));
  try {
    const normal = runCli(['run', '--seed', '7', '--tokens', '1,4,2,8,3,9']);
    assert.equal(normal.status, 0, normal.stderr);
    const write = (name, content) => {
      const file = path.join(directory, name);
      writeFileSync(file, content);
      return file;
    };
    const tamper = (mutate) => {
      const report = JSON.parse(normal.stdout);
      mutate(report);
      return JSON.stringify(report);
    };
    const cases = [
      write('oversized.json', 'x'.repeat(1024 * 1024 + 1)),
      write('malformed.json', '{"schemaVersion":1,'),
      write('schema.json', tamper((report) => { report.schemaVersion = 2; })),
      write('engine.json', tamper((report) => { report.engineVersion = '0.0.1'; })),
      write('model.json', tamper((report) => { report.model.id = 'other-model'; })),
      write('hash.json', tamper((report) => { report.model.weightsSha256 = '0'.repeat(64); })),
      write('input.json', tamper((report) => { report.input.tokens = []; })),
    ];
    for (const file of cases) {
      const result = runCli(['replay', file]);
      assert.equal(result.status, 2, path.basename(file));
      assert.equal(result.stdout, '', path.basename(file));
      assert.notEqual(result.stderr, '', path.basename(file));
    }
    assert.equal(runCli(['replay']).status, 2);
    assert.equal(runCli(['replay', path.join(directory, 'missing.json')]).status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI demo validates normal execution and every advertised fault', () => {
  const result = runCli(['demo']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /normal: PASS/);
  for (const fault of ['position-offset', 'cache-overwrite', 'mask-current-only']) {
    assert.match(result.stdout, new RegExp(`${fault}: DIVERGED at position [1-9][0-9]*`), fault);
  }
  assert.match(result.stdout, /result: PASS/);
});
