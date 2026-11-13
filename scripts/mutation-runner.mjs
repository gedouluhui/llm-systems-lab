import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MUTANT_TIMEOUT_MS = 300000;

/**
 * Counts non-overlapping occurrences of a literal target string. A mutation is
 * only trustworthy when its target appears exactly once.
 */
export function countOccurrences(text, find) {
  if (typeof text !== 'string' || typeof find !== 'string' || find.length === 0) {
    throw new Error('mutation target must be a non-empty string');
  }
  let count = 0;
  let index = 0;
  for (;;) {
    const found = text.indexOf(find, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + find.length;
  }
}

/**
 * Extracts failing test names from either TAP ("not ok N - name") or Node's
 * spec reporter ("✖ name (12.3ms)"). Only named failures count; a process
 * exit code alone is never a catch.
 */
export function failingTestNames(output) {
  const names = [];
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '');
    const tap = /^\s*not ok \d+ - (.+)$/.exec(line);
    if (tap) {
      names.push(tap[1].trim());
      continue;
    }
    const spec = /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/.exec(line);
    if (spec) {
      names.push(spec[1].trim());
    }
  }
  return [...new Set(names)];
}

export function runProcess(command, args, cwd) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: MUTANT_TIMEOUT_MS,
    windowsHide: true,
    env: environment,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? null : String(result.error.message ?? result.error),
  };
}

export function copyProject(sourceRoot, targetRoot, entries) {
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of entries) {
    const from = path.join(sourceRoot, entry);
    if (!existsSync(from)) {
      throw new Error(`mutation copy is missing required entry: ${entry}`);
    }
    cpSync(from, path.join(targetRoot, entry), { recursive: true });
  }
  const modules = path.join(sourceRoot, 'node_modules');
  const targetModules = path.join(targetRoot, 'node_modules');
  if (existsSync(modules) && !existsSync(targetModules)) {
    try {
      symlinkSync(modules, targetModules, 'junction');
    } catch {
      cpSync(modules, targetModules, { recursive: true });
    }
  }
}

function summarizeRun(buildResult, testResult) {
  return {
    ok: buildResult.status === 0 && testResult.status === 0,
    build: buildResult.status,
    tests: testResult.status,
    failedTests: failingTestNames(`${testResult.stdout}\n${testResult.stderr}`),
    diagnostic: `${buildResult.stderr}\n${testResult.stderr}`.trim().slice(-2000),
  };
}

function runCleanBaseline(sourceRoot, scratchRoot, entries, build, test) {
  const directory = mkdtempSync(path.join(scratchRoot, 'baseline-'));
  try {
    copyProject(sourceRoot, directory, entries);
    const buildResult = runProcess(build.command, build.args, directory);
    const testResult = buildResult.status === 0
      ? runProcess(test.command, test.args, directory)
      : { status: null, stdout: '', stderr: '', error: null };
    return summarizeRun(buildResult, testResult);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48);
}

function runOneMutant({ sourceRoot, scratchRoot, entries, build, test, mutant }) {
  const directory = mkdtempSync(path.join(scratchRoot, `mutant-${sanitizeName(mutant.name)}-`));
  try {
    copyProject(sourceRoot, directory, entries);
    const file = path.join(directory, mutant.file);
    if (!existsSync(file)) {
      return { name: mutant.name, status: 'TARGET-NOT-FOUND', detail: mutant.file };
    }
    const original = readFileSync(file, 'utf8');
    const occurrences = countOccurrences(original, mutant.find);
    if (occurrences === 0) {
      return { name: mutant.name, status: 'TARGET-NOT-FOUND', detail: mutant.file };
    }
    if (occurrences !== 1) {
      return { name: mutant.name, status: 'TARGET-NOT-UNIQUE', occurrences };
    }
    const mutated = original.replace(mutant.find, mutant.replace);
    if (mutated === original) {
      return { name: mutant.name, status: 'NOP', detail: 'replacement left the source unchanged' };
    }
    writeFileSync(file, mutated);

    const buildResult = runProcess(build.command, build.args, directory);
    if (buildResult.status !== 0) {
      return {
        name: mutant.name,
        status: 'BUILD-FAIL',
        expectedTest: mutant.expectedTest,
        diagnostic: buildResult.stderr.trim().slice(-2000),
      };
    }
    const testSpec = mutant.testArgs === undefined ? test : { ...test, args: mutant.testArgs };
    const testResult = runProcess(testSpec.command, testSpec.args, directory);
    const failedTests = failingTestNames(`${testResult.stdout}\n${testResult.stderr}`);
    let status;
    if (testResult.status === 0) {
      status = 'MISSED';
    } else if (failedTests.some((name) => name.includes(mutant.expectedTest))) {
      status = 'CAUGHT';
    } else {
      status = 'WRONG-FAILURE';
    }
    return {
      name: mutant.name,
      status,
      expectedTest: mutant.expectedTest,
      testStatus: testResult.status,
      failedTests,
      diagnostic: testResult.stderr.trim().slice(-2000),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Runs a clean baseline, then every mutant in its own fresh copy, then a final
 * clean baseline. The live source tree is never written. A suite passes only
 * when both baselines are green and every mutant is CAUGHT by its named test.
 */
export function runMutationSuite({
  sourceRoot,
  scratchRoot,
  entries,
  build,
  test,
  mutants,
}) {
  if (!Array.isArray(mutants) || mutants.length === 0) {
    throw new Error('mutation suite requires at least one mutant');
  }
  mkdirSync(scratchRoot, { recursive: true });
  const baseline = runCleanBaseline(sourceRoot, scratchRoot, entries, build, test);
  if (!baseline.ok) {
    return {
      passed: false,
      baseline,
      finalBaseline: null,
      results: [],
      reason: 'baseline failed',
    };
  }

  const results = [];
  for (const mutant of mutants) {
    results.push(runOneMutant({ sourceRoot, scratchRoot, entries, build, test, mutant }));
  }

  const finalBaseline = runCleanBaseline(sourceRoot, scratchRoot, entries, build, test);
  const caught = results.length === mutants.length
    && results.every((entry) => entry.status === 'CAUGHT');
  const passed = finalBaseline.ok && caught;
  let reason = null;
  if (!finalBaseline.ok) {
    reason = 'final baseline failed';
  } else if (!caught) {
    reason = 'not every mutant was caught by its named test';
  }
  return { passed, baseline, finalBaseline, results, reason };
}
