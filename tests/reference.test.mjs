import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CachedDecoder, createModel, fullForward, weightsFingerprint } from '../dist/packages/core/index.js';

const FIXTURE_URL = new URL('./fixtures/reference.json', import.meta.url);
const TOLERANCE = Object.freeze({ atol: 1e-5, rtol: 1e-4 });

function within(actual, reference) {
  return Math.abs(actual - reference) <= TOLERANCE.atol + TOLERANCE.rtol * Math.abs(reference);
}

function compareArray(actual, reference, label) {
  assert.equal(actual.length, reference.length, `${label} length`);
  for (let index = 0; index < actual.length; index += 1) {
    const expected = reference[index];
    assert.ok(Number.isFinite(actual[index]), `${label}[${index}] must be finite`);
    assert.ok(Number.isFinite(expected), `${label}[${index}] reference must be finite`);
    assert.ok(within(actual[index], expected),
      `${label}[${index}]: ${actual[index]} vs ${expected}`);
  }
}

test('checked-in reference fixture has the expected identity and provenance shape', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.modelId, 'tiny-decoder-v1');
  assert.equal(fixture.cases.length, 130);
  assert.match(fixture.provenance.decoderSha256, /^[0-9a-f]{64}$/);
  assert.match(fixture.provenance.generatorSha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.cases[0].seed, 1000);
  assert.equal(fixture.cases[128].seed, 321);
  assert.equal(fixture.cases[128].tokens.length, 64);
  assert.deepEqual(fixture.cases[129].tokens, [0, 1, 0]);
});

test('TypeScript matches the independent NumPy reference on every reserved case', async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
  const fingerprints = new Map();
  for (const [caseIndex, item] of fixture.cases.entries()) {
    let model = fingerprints.get(item.seed);
    if (model === undefined) {
      model = createModel(item.seed);
      fingerprints.set(item.seed, model);
      assert.equal(await weightsFingerprint(model), item.weightsSha256,
        `weights hash for seed ${item.seed}`);
    }
    const result = fullForward(model, item.tokens);
    const length = item.tokens.length;
    for (let row = 0; row < length; row += 1) {
      compareArray(result.logits.subarray(row * 32, (row + 1) * 32), item.logits[row],
        `case ${caseIndex} (seed ${item.seed}) logits[${row}]`);
    }
    for (let layer = 0; layer < 2; layer += 1) {
      for (let row = 0; row < length; row += 1) {
        compareArray(result.hidden[layer].subarray(row * 16, (row + 1) * 16),
          item.hidden[layer][row], `case ${caseIndex} hidden[${layer}][${row}]`);
        compareArray(result.cache[layer].keys.subarray(row * 16, (row + 1) * 16),
          item.cache[layer].keys[row], `case ${caseIndex} keys[${layer}][${row}]`);
        compareArray(result.cache[layer].values.subarray(row * 16, (row + 1) * 16),
          item.cache[layer].values[row], `case ${caseIndex} values[${layer}][${row}]`);
      }
    }
  }
});

test('CachedDecoder matches the independent NumPy reference step by step on every reserved case', async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
  const models = new Map();
  for (const [caseIndex, item] of fixture.cases.entries()) {
    let model = models.get(item.seed);
    if (model === undefined) {
      model = createModel(item.seed);
      models.set(item.seed, model);
    }
    const decoder = new CachedDecoder(model);
    for (let row = 0; row < item.tokens.length; row += 1) {
      const step = decoder.step(item.tokens[row]);
      assert.equal(step.position, row, `case ${caseIndex} step position`);
      assert.equal(step.token, item.tokens[row], `case ${caseIndex} step token`);
      compareArray(step.logits, item.logits[row],
        `case ${caseIndex} (seed ${item.seed}) cached logits[${row}]`);
      for (let layer = 0; layer < 2; layer += 1) {
        compareArray(step.hidden[layer], item.hidden[layer][row],
          `case ${caseIndex} (seed ${item.seed}) cached hidden[${layer}][${row}]`);
      }
    }
    assert.equal(decoder.length, item.tokens.length, `case ${caseIndex} cached length`);
    const snapshot = decoder.snapshot();
    assert.equal(snapshot.length, 2, `case ${caseIndex} snapshot layer count`);
    for (let layer = 0; layer < 2; layer += 1) {
      for (let row = 0; row < item.tokens.length; row += 1) {
        compareArray(snapshot[layer].keys.subarray(row * 16, (row + 1) * 16),
          item.cache[layer].keys[row], `case ${caseIndex} cached keys[${layer}][${row}]`);
        compareArray(snapshot[layer].values.subarray(row * 16, (row + 1) * 16),
          item.cache[layer].values[row], `case ${caseIndex} cached values[${layer}][${row}]`);
      }
    }
  }
});
