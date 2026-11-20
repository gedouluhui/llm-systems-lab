import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutationSuite } from './mutation-runner.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRATCH_ROOT = path.join(PROJECT_ROOT, 'artifacts', 'mutation');
const ENTRIES = ['packages', 'src', 'scripts', 'tests', 'tsconfig.json', 'package.json'];

const BUILD = {
  command: process.execPath,
  args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
};

const ALL_TESTS = [
  'tests/contracts.test.mjs',
  'tests/model.test.mjs',
  'tests/math.test.mjs',
  'tests/decoder.test.mjs',
  'tests/reference.test.mjs',
  'tests/paging.test.mjs',
  'tests/experiment.test.mjs',
  'tests/cli.test.mjs',
  'tests/mutation-runner.test.mjs',
];

const TEST = {
  command: process.execPath,
  args: ['--test', '--test-reporter=tap', ...ALL_TESTS],
};

function focusedTest(file) {
  return ['--test', '--test-reporter=tap', file];
}

const DIVERGENCE_TEST = 'teaching faults agree at position 0 and diverge later on a nontrivial sequence';

const MUTANTS = [
  {
    name: 'position-offset-disabled',
    file: 'packages/core/decoder.ts',
    find: '? (position + 1) % MODEL_SPEC.maxContext',
    replace: '? position',
    expectedTest: DIVERGENCE_TEST,
    testArgs: focusedTest('tests/decoder.test.mjs'),
  },
  {
    name: 'cache-overwrite-disabled',
    file: 'packages/core/decoder.ts',
    find: "this.fault === 'cache-overwrite' && position > 0 ? 0 : null",
    replace: "this.fault === 'cache-overwrite' && position > MODEL_SPEC.maxContext ? 0 : null",
    expectedTest: DIVERGENCE_TEST,
    testArgs: focusedTest('tests/decoder.test.mjs'),
  },
  {
    name: 'mask-current-only-disabled',
    file: 'packages/core/decoder.ts',
    find: "this.fault === 'mask-current-only'",
    replace: "false && this.fault === 'mask-current-only'",
    expectedTest: DIVERGENCE_TEST,
    testArgs: focusedTest('tests/decoder.test.mjs'),
  },
  {
    name: 'comparison-always-pass',
    file: 'packages/core/experiment.ts',
    find: 'passes: firstMismatch === null,',
    replace: 'passes: true,',
    expectedTest: 'compareVectors reports a non-argmax coordinate difference',
    testArgs: focusedTest('tests/experiment.test.mjs'),
  },
  {
    name: 'paging-floor-instead-of-ceil',
    file: 'packages/simulator/index.ts',
    find: 'const needed = Math.ceil(tokens / this.pageSize) - allocatedPages;',
    replace: 'const needed = Math.floor(tokens / this.pageSize) - allocatedPages;',
    expectedTest: 'known accounting example: 32 tokens, then 33 tokens with 16-token pages',
    testArgs: focusedTest('tests/paging.test.mjs'),
  },
  {
    name: 'tolerance-widened-1000x',
    file: 'packages/core/experiment.ts',
    find: 'const threshold = atol + rtol * Math.abs(referenceValue);',
    replace: 'const threshold = (atol + rtol * Math.abs(referenceValue)) * 1000;',
    expectedTest: 'compareVectors applies inclusive absolute and relative tolerance boundaries',
    testArgs: focusedTest('tests/experiment.test.mjs'),
  },
  {
    name: 'lcg-uint32-wrap-dropped',
    file: 'packages/core/model.ts',
    find: 'this.state = (Math.imul(this.state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;',
    replace: 'this.state = (Math.imul(this.state, LCG_MULTIPLIER) + LCG_INCREMENT);',
    expectedTest: 'weight fingerprint matches the independent NumPy reference for seed 0',
    testArgs: focusedTest('tests/model.test.mjs'),
  },
  {
    name: 'context-limit-off-by-one',
    file: 'packages/contracts/index.ts',
    find: 'if (length > MODEL_SPEC.maxContext) {',
    replace: 'if (length > MODEL_SPEC.maxContext + 1) {',
    expectedTest: 'token validators distinguish context overflow from other INPUT failures',
    testArgs: focusedTest('tests/contracts.test.mjs'),
  },
  {
    name: 'vocabulary-boundary-inclusive',
    file: 'packages/contracts/index.ts',
    find: 'token < 0 || token >= MODEL_SPEC.vocabSize',
    replace: 'token < 0 || token > MODEL_SPEC.vocabSize',
    expectedTest: 'token validators reject non-integers, coercible objects, and out-of-vocabulary values',
    testArgs: focusedTest('tests/contracts.test.mjs'),
  },
  {
    name: 'released-pages-descending',
    file: 'packages/simulator/index.ts',
    find: 'releasedPages: [...existing.pages].sort((left, right) => left - right),',
    replace: 'releasedPages: [...existing.pages].sort((left, right) => right - left),',
    expectedTest: 'release frees pages and later appends reuse the lowest free page',
    testArgs: focusedTest('tests/paging.test.mjs'),
  },
  {
    name: 'seed-bounds-skipped',
    file: 'packages/contracts/index.ts',
    find: '|| value < 0 || value > 4294967295',
    replace: '|| false',
    expectedTest: 'validateSeed and validateInput reject invalid seed types and bounds',
    testArgs: focusedTest('tests/contracts.test.mjs'),
  },
];

function checkScratchBoundary() {
  const relative = path.relative(PROJECT_ROOT, SCRATCH_ROOT);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('mutation scratch directory must live inside the project');
  }
}

function printBaseline(label, baseline) {
  if (baseline === null) {
    console.log(`${label}: SKIPPED`);
    return;
  }
  const failed = baseline.failedTests.length === 0 ? '' : ` failing=[${baseline.failedTests.join(', ')}]`;
  console.log(
    `${label}: ${baseline.ok ? 'PASS' : 'FAIL'} (build=${String(baseline.build)}, tests=${String(baseline.tests)})${failed}`,
  );
}

async function main() {
  checkScratchBoundary();
  console.log('llm-systems-lab source mutation check');
  console.log(`source root: ${PROJECT_ROOT}`);
  console.log(`scratch: ${SCRATCH_ROOT} (ignored; fresh copies per run)`);
  console.log('rule: a mutant counts only when the build succeeds and its named test fails');

  const suite = runMutationSuite({
    sourceRoot: PROJECT_ROOT,
    scratchRoot: SCRATCH_ROOT,
    entries: ENTRIES,
    build: BUILD,
    test: TEST,
    mutants: MUTANTS,
  });

  printBaseline('baseline', suite.baseline);
  for (const result of suite.results) {
    const expected = result.expectedTest === undefined ? '' : ` expected="${result.expectedTest}"`;
    console.log(`- ${result.name}: ${result.status}${expected}`);
    if (result.status !== 'CAUGHT') {
      if (Array.isArray(result.failedTests) && result.failedTests.length > 0) {
        console.log(`    failing tests: ${result.failedTests.join(' | ')}`);
      }
      if (typeof result.diagnostic === 'string' && result.diagnostic.length > 0) {
        console.log(`    diagnostic: ${result.diagnostic.split('\n').slice(-6).join('\n    ')}`);
      }
      if (typeof result.occurrences === 'number') {
        console.log(`    occurrences: ${result.occurrences}`);
      }
    }
  }
  printBaseline('final baseline', suite.finalBaseline);

  const caught = suite.results.filter((entry) => entry.status === 'CAUGHT').length;
  if (suite.reason !== null) {
    console.log(`reason: ${suite.reason}`);
  }
  console.log(`result: ${suite.passed ? 'PASS' : 'FAIL'} (${caught}/${MUTANTS.length} mutants caught)`);
  return suite.passed ? 0 : 1;
}

process.exitCode = await main();
