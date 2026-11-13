import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runMutationSuite } from '../scripts/mutation-runner.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const SOURCE = `export function add(a, b) {
  // duplicated target
  // duplicated target
  return a + b;
}
`;

const TEST_SOURCE = `import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from '../src/add.mjs';

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5);
});
`;

function createMiniProject(parent, { failing = false } = {}) {
  const directory = mkdtempSync(path.join(parent, 'mini-'));
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  mkdirSync(path.join(directory, 'tests'), { recursive: true });
  writeFileSync(path.join(directory, 'src', 'add.mjs'), SOURCE);
  writeFileSync(
    path.join(directory, 'tests', 'add.test.mjs'),
    failing ? TEST_SOURCE.replace('add(2, 3), 5', 'add(2, 3), 6') : TEST_SOURCE,
  );
  return directory;
}

function baseOptions(sourceRoot, scratchRoot, mutants) {
  return {
    sourceRoot,
    scratchRoot,
    entries: ['src', 'tests'],
    build: { command: process.execPath, args: ['--check', 'src/add.mjs'] },
    test: { command: process.execPath, args: ['--test', '--test-reporter=tap', 'tests/add.test.mjs'] },
    mutants,
  };
}

test('mutation runner classifies caught, missed, no-op, build, and wrong failures', () => {
  const scratch = path.join(ROOT, 'artifacts', 'mutation-runner-test');
  mkdirSync(scratch, { recursive: true });
  const project = createMiniProject(scratch);
  const sourceBefore = readFileSync(path.join(project, 'src', 'add.mjs'), 'utf8');
  try {
    const suite = runMutationSuite(baseOptions(project, path.join(scratch, 'runs'), [
      {
        name: 'caught',
        file: 'src/add.mjs',
        find: 'return a + b;',
        replace: 'return a - b;',
        expectedTest: 'add sums two numbers',
      },
      {
        name: 'survivor',
        file: 'src/add.mjs',
        find: 'return a + b;',
        replace: 'return b + a;',
        expectedTest: 'add sums two numbers',
      },
      {
        name: 'wrong-failure',
        file: 'src/add.mjs',
        find: 'return a + b;',
        replace: 'return a - b;',
        expectedTest: 'an assertion that does not exist',
      },
      {
        name: 'build-fail',
        file: 'src/add.mjs',
        find: 'return a + b;',
        replace: 'return a +;',
        expectedTest: 'add sums two numbers',
      },
      {
        name: 'no-op',
        file: 'src/add.mjs',
        find: 'return a + b;',
        replace: 'return a + b;',
        expectedTest: 'add sums two numbers',
      },
      {
        name: 'not-unique',
        file: 'src/add.mjs',
        find: '// duplicated target',
        replace: '// changed target',
        expectedTest: 'add sums two numbers',
      },
      {
        name: 'not-found',
        file: 'src/add.mjs',
        find: 'return a * b;',
        replace: 'return a / b;',
        expectedTest: 'add sums two numbers',
      },
    ]));

    const statuses = Object.fromEntries(suite.results.map((entry) => [entry.name, entry.status]));
    assert.deepEqual(statuses, {
      caught: 'CAUGHT',
      survivor: 'MISSED',
      'wrong-failure': 'WRONG-FAILURE',
      'build-fail': 'BUILD-FAIL',
      'no-op': 'NOP',
      'not-unique': 'TARGET-NOT-UNIQUE',
      'not-found': 'TARGET-NOT-FOUND',
    });
    assert.equal(suite.baseline.ok, true);
    assert.equal(suite.finalBaseline.ok, true);
    assert.equal(suite.passed, false);
    assert.equal(readFileSync(path.join(project, 'src', 'add.mjs'), 'utf8'), sourceBefore);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(path.join(scratch, 'runs'), { recursive: true, force: true });
  }
});

test('mutation runner refuses to score mutants when the clean baseline fails', () => {
  const scratch = path.join(ROOT, 'artifacts', 'mutation-runner-baseline');
  mkdirSync(scratch, { recursive: true });
  const project = createMiniProject(scratch, { failing: true });
  try {
    const suite = runMutationSuite(baseOptions(project, path.join(scratch, 'runs'), [
      {
        name: 'caught',
        file: 'src/add.mjs',
        find: 'return a + b;',
        replace: 'return a - b;',
        expectedTest: 'add sums two numbers',
      },
    ]));
    assert.equal(suite.passed, false);
    assert.equal(suite.baseline.ok, false);
    assert.equal(suite.reason, 'baseline failed');
    assert.deepEqual(suite.results, []);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(path.join(scratch, 'runs'), { recursive: true, force: true });
  }
});
