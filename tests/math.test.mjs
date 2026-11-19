import assert from 'node:assert/strict';
import test from 'node:test';
import { dot, layerNorm, matmul, softmaxRow } from '../dist/packages/core/index.js';

test('dot multiplies small integer vectors', () => {
  assert.equal(dot(new Float32Array([1, 2, 3]), 0, new Float32Array([4, 5, 6]), 0, 3), 32);
});

test('dot preserves the unit term through f64 cancellation', () => {
  const a = new Float32Array([16777216, 1, -16777216]);
  const b = new Float32Array([1, 1, 1]);
  assert.equal(dot(a, 0, b, 0, 3), 1);
});

test('matmul preserves the unit term through f64 cancellation', () => {
  const a = new Float32Array([16777216, 1, -16777216]);
  const b = new Float32Array([1, 1, 1]);
  assert.equal(matmul(a, 1, 3, b, 1)[0], 1);
});

test('layerNorm matches an independently computed scalar example', () => {
  assert.equal(typeof layerNorm, 'function', 'layerNorm is unavailable');
  const input = new Float32Array([1, 2, 3]);
  const mean = 2;
  const variance = ((1 - mean) ** 2 + (2 - mean) ** 2 + (3 - mean) ** 2) / 3;
  const denominator = Math.sqrt(variance + 1e-5);
  const expected = [1, 2, 3].map((value) => Math.fround((value - mean) / denominator));
  const actual = layerNorm(input, 0, 3);
  assert.ok(actual instanceof Float32Array);
  assert.equal(actual.length, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(actual[index], expected[index], `element ${index}`);
  }
  const zero = layerNorm(new Float32Array([0, 0, 0]), 0, 3);
  assert.deepEqual(Array.from(zero), [0, 0, 0]);
  assert.ok(Array.from(zero).every(Number.isFinite));
});

test('softmaxRow matches an independently computed scalar example', () => {
  assert.equal(typeof softmaxRow, 'function', 'softmaxRow is unavailable');
  const shifted = [Math.exp(-2), Math.exp(-1), Math.exp(0)];
  const denominator = shifted[0] + shifted[1] + shifted[2];
  const expected = shifted.map((value) => Math.fround(value / denominator));
  const actual = softmaxRow(new Float64Array([1, 2, 3]), 3);
  assert.ok(actual instanceof Float32Array);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(actual[index], expected[index], `element ${index}`);
  }
  const huge = softmaxRow(new Float64Array([1000, 1000]), 2);
  assert.deepEqual(Array.from(huge), [0.5, 0.5]);
});

test('matmul multiplies row-major matrices with double accumulation', () => {
  assert.equal(typeof matmul, 'function', 'matmul is unavailable');
  const left = new Float32Array([1, 2, 3, 4]);
  const right = new Float32Array([5, 6, 7, 8]);
  const product = matmul(left, 2, 2, right, 2);
  assert.deepEqual(Array.from(product), [19, 22, 43, 50]);
  const projective = matmul(new Float32Array([1, 2]), 1, 2, right, 2);
  assert.deepEqual(Array.from(projective), [19, 22]);
});

test('matmul results stay finite for large-but-representable inputs', () => {
  const values = new Float32Array([2 ** 60, 2 ** 60]);
  const weights = new Float32Array([2 ** 60, 2 ** 60]);
  const product = matmul(values, 1, 2, weights, 1);
  assert.ok(Number.isFinite(product[0]));
  assert.equal(product[0], 2 ** 121);
});
