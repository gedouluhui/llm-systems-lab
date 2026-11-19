import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dot, layerNorm, matmul, softmaxRow } from '../dist/packages/core/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/operator-bounds-v1.json', import.meta.url), 'utf8'));

function within(actual, expected, budget, label) {
  const reference = Number(expected);
  // Decimal -> binary64 conversion and the subtraction used to measure error.
  // This guard scales with the value, not the model's much looser atol/rtol.
  const limit = Number(budget) * (1 + 4 * Number.EPSILON)
    + Number.EPSILON * Math.abs(reference);
  assert.ok(Number.isFinite(actual), `${label}: non-finite output ${actual}`);
  assert.ok(Math.abs(actual - reference) <= limit,
    `${label}: ${actual} vs Decimal ${expected}, absolute budget ${limit}`);
}

test('local operator evidence is tied to its independent generator', () => {
  // The digest is over the generator's text, not over a checkout's line endings.
  const source = readFileSync(new URL('../reference/operator_bounds.py', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex'),
    fixture.generatorSha256);
  assert.equal(fixture.schemaVersion, 1);
});

for (const entry of fixture.dots) {
  test(`dot exact-rational bound: ${entry.name}`, () => {
    // Nonzero offsets and unrelated padding detect accidentally reading full buffers.
    const left = new Float32Array([999, ...entry.left, 777]);
    const right = new Float32Array([555, 444, ...entry.right, 333]);
    within(dot(left, 1, right, 2, entry.left.length), entry.exact, entry.dotAbsoluteBound, entry.name);
  });
  test(`matmul f64 accumulation plus f32 output bound: ${entry.name}`, () => {
    const actual = matmul(new Float32Array(entry.left), 1, entry.left.length,
      new Float32Array(entry.right), 1);
    assert.ok(actual instanceof Float32Array);
    assert.equal(actual.length, 1);
    within(actual[0], entry.exact, entry.outputAbsoluteBound, entry.name);
  });
}

for (const entry of fixture.matrices) {
  test(`matmul independent row-major scalar bound: ${entry.name}`, () => {
    const actual = matmul(new Float32Array(entry.left), entry.rows, entry.columns,
      new Float32Array(entry.right), entry.rightColumns);
    assert.equal(actual.length, entry.expected.length);
    entry.expected.forEach((expected, index) => {
      within(actual[index], expected.exact, expected.outputAbsoluteBound, `cell ${index}`);
    });
  });
}

test('matmul retains product low bits until cancellation and final storage', () => {
  // (1 + 2^-23)(1 - 2^-23) - 1 = -2^-46 exactly; fp32 products would give 0.
  const a = new Float32Array([1 + 2 ** -23, -1]);
  const b = new Float32Array([1 - 2 ** -23, 1]);
  assert.equal(matmul(a, 1, 2, b, 1)[0], -(2 ** -46));
});

test('dot returns f64 while matmul materializes one ties-to-even f32 result', () => {
  const a = new Float32Array([1, 2 ** -24]);
  const b = new Float32Array([1, 1]);
  assert.equal(dot(a, 0, b, 0, 2), 1 + 2 ** -24);
  assert.equal(matmul(a, 1, 2, b, 1)[0], 1);
});

for (const entry of fixture.softmax) {
  test(`softmax independent Decimal values and normalization: ${entry.name}`, () => {
    const actual = softmaxRow(new Float64Array([...entry.scores, 1e6]), entry.scores.length);
    assert.ok(actual instanceof Float32Array);
    assert.equal(actual.length, entry.scores.length);
    entry.expected.forEach((expected, index) => {
      within(actual[index], expected.exact, expected.absoluteBudget, `${entry.name}[${index}]`);
      assert.ok(actual[index] >= 0 && actual[index] <= 1);
    });
    // Sum the per-coordinate budgets, plus binary64 measurement rounding.
    const budget = entry.expected.reduce((sum, value) => sum + Number(value.absoluteBudget), 0);
    assert.ok(Math.abs(Array.from(actual).reduce((sum, value) => sum + value, 0) - 1)
      <= budget + entry.scores.length * Number.EPSILON, `${entry.name}: normalization`);
  });
}

test('softmax is unchanged by a representable common score translation', () => {
  const base = fixture.softmax.find((entry) => entry.name === 'base');
  const shifted = fixture.softmax.find((entry) => entry.name === 'shifted');
  assert.deepEqual(softmaxRow(new Float64Array(base.scores), base.scores.length),
    softmaxRow(new Float64Array(shifted.scores), shifted.scores.length));
});

for (const entry of fixture.layerNorm) {
  test(`LayerNorm independent pairwise-variance Decimal values: ${entry.name}`, () => {
    const actual = layerNorm(new Float32Array([999, ...entry.input, 777]), 1, entry.input.length);
    assert.ok(actual instanceof Float32Array);
    assert.equal(actual.length, entry.input.length);
    entry.expected.forEach((expected, index) => {
      within(actual[index], expected.exact, expected.absoluteBudget, `${entry.name}[${index}]`);
    });
    if (entry.name === 'constant') {
      assert.deepEqual(Array.from(actual), [0, 0, 0, 0]);
    }
  });
}
