import assert from 'node:assert/strict';
import test from 'node:test';
import { LabError, MODEL_SPEC } from '../dist/packages/contracts/index.js';
import {
  ENGINE_VERSION,
  compareVectors,
  replayExperiment,
  resolveFirstDivergence,
  runExperiment,
} from '../dist/packages/core/index.js';

const normalInput = () => ({
  schemaVersion: 1,
  seed: 7,
  tokens: [1, 4, 2, 8, 3, 9],
  fault: 'none',
});

function rejects(action, code, label) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof LabError, label);
    assert.equal(error.code, code, label);
    return true;
  }, label);
}

function rejectsAsync(action, code, label) {
  return assert.rejects(action, (error) => {
    assert.ok(error instanceof LabError, label);
    assert.equal(error.code, code, label);
    return true;
  }, label);
}

test('compareVectors passes identical vectors with zero error', () => {
  const result = compareVectors([0, 1.5, -2], [0, 1.5, -2]);
  assert.deepEqual(result, {
    passes: true,
    length: 3,
    maxAbsoluteError: 0,
    maxRelativeError: 0,
    firstMismatch: null,
  });
});

test('compareVectors rejects empty or differently shaped vectors', () => {
  rejects(() => compareVectors([], []), 'INPUT', 'empty vectors');
  rejects(() => compareVectors([1], []), 'INPUT', 'empty reference');
  rejects(() => compareVectors([], [1]), 'INPUT', 'empty actual');
  rejects(() => compareVectors([1, 2], [1]), 'INPUT', 'shorter reference');
  rejects(() => compareVectors([1], [1, 2]), 'INPUT', 'longer reference');
});

test('compareVectors rejects non-finite values instead of reporting a number', () => {
  for (const [actual, reference] of [
    [[NaN], [0]],
    [[Infinity], [0]],
    [[-Infinity], [0]],
    [[0], [NaN]],
    [[0], [Infinity]],
    [[0], [-Infinity]],
  ]) {
    rejects(() => compareVectors(actual, reference), 'NON_FINITE', 'non-finite input');
  }
});

test('compareVectors reports a non-argmax coordinate difference', () => {
  const reference = new Array(32).fill(0);
  reference[3] = 2;
  const actual = reference.slice();
  actual[17] = 0.5;
  const result = compareVectors(actual, reference);
  assert.equal(result.length, 32);
  assert.equal(result.passes, false);
  assert.equal(result.firstMismatch, 17);
  assert.ok(Math.abs(result.maxAbsoluteError - 0.5) < 1e-12);
});

test('compareVectors applies inclusive absolute and relative tolerance boundaries', () => {
  assert.equal(compareVectors([1e-5], [0]).passes, true, 'absolute boundary is inclusive');
  assert.equal(compareVectors([1.00001e-5], [0]).passes, false, 'just above absolute boundary');
  assert.equal(compareVectors([1.0001], [1]).passes, true, 'inside the relative tolerance');
  assert.equal(compareVectors([1.00012], [1]).passes, false, 'outside the relative tolerance');
  assert.equal(compareVectors([1e-5], [0]).maxRelativeError, 1, 'zero reference uses atol as scale');
});

test('runExperiment is deterministic and reports real full and cached results', async () => {
  const input = normalInput();
  const first = await runExperiment(input);
  const second = await runExperiment({ ...input, tokens: [...input.tokens] });
  assert.deepEqual(first, second);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.engineVersion, ENGINE_VERSION);
  assert.equal(first.mode, 'numerical');
  assert.equal(first.model.id, MODEL_SPEC.id);
  assert.equal(first.model.untrained, true);
  assert.match(first.model.weightsSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.model.storage, 'float32');
  assert.equal(first.model.accumulation, 'float64');
  assert.deepEqual(first.input, input);
  assert.deepEqual(first.tolerances, { atol: 1e-5, rtol: 1e-4 });

  assert.equal(first.steps.length, 6);
  assert.equal(first.comparison.passes, true);
  assert.equal(first.comparison.firstDivergence, null);
  assert.equal(first.comparison.stepsCompared, 6);
  assert.equal(first.comparison.cache.passes, true);
  assert.equal(first.comparison.cache.firstMismatch, null);

  assert.equal(first.finalCache.length, 2);
  for (const layer of first.finalCache) {
    assert.equal(layer.rows, 6);
    assert.equal(layer.keys.length, 6 * 16);
    assert.equal(layer.values.length, 6 * 16);
  }

  const firstStep = first.steps[0];
  assert.equal(firstStep.position, 0);
  assert.equal(firstStep.token, 1);
  assert.equal(firstStep.fullLogits.length, 32);
  assert.deepEqual(firstStep.cachedLogits, firstStep.fullLogits);
  assert.equal(firstStep.logits.passes, true);
  assert.equal(firstStep.hidden.length, 2);
  assert.equal(firstStep.hidden[0].layer, 0);
  assert.equal(firstStep.cacheEvents.length, 2);
  assert.equal(firstStep.cacheEvents[0].writeSlot, 0);
  assert.equal(Object.hasOwn(first, 'timestamp'), false);
  assert.equal(JSON.stringify(first).includes('timestamp'), false);
});

test('a cache-only mismatch is attributed to the last token position', () => {
  assert.equal(resolveFirstDivergence(null, true, 6), null);
  assert.equal(resolveFirstDivergence(2, false, 6), 2);
  assert.equal(resolveFirstDivergence(null, false, 6), 5);
  assert.equal(resolveFirstDivergence(0, false, 1), 0);
});

test('workSummary reports deterministic counts for normal, masked and recompute modes', async () => {
  const normal = await runExperiment(normalInput());
  assert.deepEqual(normal.workSummary, {
    totalRecomputeTokens: 6,
    expectedCachedTokens: 6,
    totalKvReadSlots: 2 * 21,
    totalAttentionMacs: 2 * 8 * 2 * 2 * 21,
    complexityClass: 'O(T) step / O(T^2) total',
  });
  assert.deepEqual(normal.steps.map((step) => step.work.recomputeTokens), [1, 1, 1, 1, 1, 1]);

  const masked = await runExperiment({ ...normalInput(), fault: 'mask-current-only' });
  assert.deepEqual(masked.workSummary, {
    totalRecomputeTokens: 6,
    expectedCachedTokens: 6,
    totalKvReadSlots: 2 * 6,
    totalAttentionMacs: 2 * 8 * 2 * 2 * 6,
    complexityClass: 'O(1) masked',
  });

  const degraded = await runExperiment({ ...normalInput(), fault: 'no-cache-recompute' });
  assert.equal(degraded.comparison.passes, true, 'recompute mode is numerically exact');
  assert.equal(degraded.comparison.firstDivergence, null);
  assert.deepEqual(degraded.steps.map((step) => step.work.recomputeTokens), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(degraded.workSummary, {
    totalRecomputeTokens: 21,
    expectedCachedTokens: 6,
    totalKvReadSlots: 2 * 56,
    totalAttentionMacs: 2 * 8 * 2 * 2 * 56,
    complexityClass: 'O(T^2) step / O(T^3) total',
  });
});

test('runExperiment derives divergence from computed vectors for every teaching fault', async () => {
  const tokens = [1, 4, 2, 8, 3, 9];
  const normal = await runExperiment({ schemaVersion: 1, seed: 7, tokens, fault: 'none' });
  assert.equal(normal.comparison.passes, true, 'normal path itself must not diverge');
  assert.equal(normal.comparison.passes, normal.comparison.firstDivergence === null);

  for (const fault of ['position-offset', 'cache-overwrite', 'mask-current-only']) {
    const result = await runExperiment({ schemaVersion: 1, seed: 7, tokens, fault });
    assert.equal(result.input.fault, fault);
    assert.equal(result.comparison.passes, false, fault);
    assert.equal(result.comparison.passes, result.comparison.firstDivergence === null, fault);
    assert.notEqual(result.comparison.firstDivergence, null, fault);
    assert.ok(result.comparison.firstDivergence >= 1, `${fault} first divergence`);
    assert.equal(result.steps[0].logits.passes, true, `${fault} agrees at position 0`);
    assert.ok(result.steps[0].hidden.every((entry) => entry.comparison.passes), `${fault} hidden at 0`);
  }
});

test('runExperiment responds to actual token changes at the first differing position', async () => {
  const prefix = [1, 4, 2, 8, 3];
  const base = await runExperiment({ schemaVersion: 1, seed: 7, tokens: [...prefix, 9], fault: 'none' });
  const changed = await runExperiment({ schemaVersion: 1, seed: 7, tokens: [...prefix, 8], fault: 'none' });
  for (let position = 0; position < prefix.length; position += 1) {
    assert.deepEqual(changed.steps[position].fullLogits, base.steps[position].fullLogits, `position ${position}`);
  }
  assert.notDeepEqual(changed.steps[5].fullLogits, base.steps[5].fullLogits);
  const otherSeed = await runExperiment({ schemaVersion: 1, seed: 8, tokens: [1], fault: 'none' });
  assert.notEqual(otherSeed.model.weightsSha256, base.model.weightsSha256);
});

test('runExperiment rejects invalid input before computing', async () => {
  const valid = { schemaVersion: 1, seed: 7, tokens: [1], fault: 'none' };
  for (const bad of [
    {},
    { ...valid, schemaVersion: 2 },
    { ...valid, tokens: [] },
    { ...valid, fault: 'unknown' },
    { ...valid, extra: 1 },
    { ...valid, seed: -1 },
    { ...valid, seed: 1.5 },
    null,
    5,
    'input',
    [],
  ]) {
    await rejectsAsync(() => runExperiment(bad), 'INPUT', 'invalid experiment input');
  }
  await rejectsAsync(() => runExperiment({ ...valid, tokens: Array(65).fill(0) }), 'CONTEXT_LIMIT', 'context overflow');
});

test('replayExperiment recomputes from input and returns deeply identical results', async () => {
  const original = await runExperiment(normalInput());
  const roundTripped = JSON.parse(JSON.stringify(original));
  const replayed = await replayExperiment(roundTripped);
  assert.deepEqual(replayed, original);
  assert.notStrictEqual(replayed, roundTripped);
  assert.notStrictEqual(replayed.steps, roundTripped.steps);
});

test('replayExperiment ignores recorded results and recomputes them', async () => {
  const original = await runExperiment(normalInput());
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.steps = [{
    position: 0,
    token: 31,
    fullLogits: [1],
    cachedLogits: [2],
    logits: { passes: false, length: 1, maxAbsoluteError: 99, maxRelativeError: 99, firstMismatch: 0 },
    hidden: [],
    cacheEvents: [],
  }];
  tampered.comparison = { passes: false, firstDivergence: 0, stepsCompared: 1, cache: { passes: false } };
  tampered.finalCache = [];
  const replayed = await replayExperiment(tampered);
  assert.deepEqual(replayed, original);
});

test('replayExperiment rejects unsupported metadata and weight fingerprints', async () => {
  const original = await runExperiment(normalInput());
  const mutations = [
    (report) => { report.schemaVersion = 2; },
    (report) => { report.engineVersion = '0.0.1'; },
    (report) => { report.model.id = 'other-model'; },
    (report) => { report.model.weightsSha256 = '0'.repeat(64); },
    (report) => { delete report.model.weightsSha256; },
    (report) => { report.model = null; },
    (report) => { delete report.input; },
    (report) => { report.input = { ...report.input, tokens: [] }; },
    (report) => { report.input = { ...report.input, extra: true }; },
  ];
  for (const mutate of mutations) {
    const report = JSON.parse(JSON.stringify(original));
    mutate(report);
    await rejectsAsync(() => replayExperiment(report), 'INPUT', 'tampered replay report');
  }
  for (const bad of [null, 1, 'report', [], {}]) {
    await rejectsAsync(() => replayExperiment(bad), 'INPUT', 'non-report value');
  }
});
