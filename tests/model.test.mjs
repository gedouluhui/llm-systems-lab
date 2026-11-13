import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createModel, weightsFingerprint } from '../dist/packages/core/index.js';

const SHAPES = {
  embeddings: [32, 16],
  positions: [64, 16],
  q: [16, 16], k: [16, 16], v: [16, 16], o: [16, 16],
  up: [16, 32], down: [32, 16],
  lmHead: [16, 32],
};

function expectMatrix(value, [rows, cols], label) {
  assert.ok(value instanceof Float32Array, `${label} must be a Float32Array`);
  assert.equal(value.length, rows * cols, `${label} length`);
  for (const scalar of value) {
    assert.ok(Number.isFinite(scalar), `${label} must be finite`);
  }
}

function serialize(model) {
  const arrays = [
    model.embeddings,
    model.positions,
    ...model.layers.flatMap((layer) => [layer.q, layer.k, layer.v, layer.o, layer.up, layer.down]),
    model.lmHead,
  ];
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const buffer = new ArrayBuffer(total * 4);
  const view = new DataView(buffer);
  let offset = 0;
  for (const array of arrays) {
    for (const scalar of array) {
      view.setFloat32(offset, scalar, true);
      offset += 4;
    }
  }
  assert.equal(offset, total * 4);
  return Buffer.from(buffer);
}

function sha256(model) {
  return createHash('sha256').update(serialize(model)).digest('hex');
}

test('createModel exposes the frozen shapes as float32 storage', () => {
  assert.equal(typeof createModel, 'function', 'model construction is unavailable');
  assert.equal(typeof weightsFingerprint, 'function', 'weight fingerprinting is unavailable');
  for (const seed of [0, 1, 7, 42, 4294967295]) {
    const model = createModel(seed);
    assert.equal(model.id, 'tiny-decoder-v1');
    assert.equal(model.seed, seed);
    expectMatrix(model.embeddings, SHAPES.embeddings, 'embeddings');
    expectMatrix(model.positions, SHAPES.positions, 'positions');
    assert.equal(model.layers.length, 2, 'layer count');
    for (const [index, layer] of model.layers.entries()) {
      for (const name of ['q', 'k', 'v', 'o', 'up', 'down']) {
        expectMatrix(layer[name], SHAPES[name], `layer ${index} ${name}`);
      }
    }
    expectMatrix(model.lmHead, SHAPES.lmHead, 'lmHead');
  }
});

test('same seed is byte-identical and different seeds differ', () => {
  const a = createModel(7);
  const b = createModel(7);
  const c = createModel(8);
  assert.deepEqual(Buffer.from(serialize(a)), Buffer.from(serialize(b)));
  assert.notDeepEqual(serialize(a), serialize(c));
});

test('seed 1 first generated weights follow the documented LCG states', () => {
  const model = createModel(1);
  const first = Math.fround((1015568748 / 4294967296 - 0.5) * 0.6);
  const second = Math.fround((1586005467 / 4294967296 - 0.5) * 0.6);
  assert.equal(model.embeddings[0], first);
  assert.equal(model.embeddings[1], second);
});

test('weightsFingerprint is stable, seed-sensitive and matches independent serialization', async () => {
  const a = createModel(1);
  const b = createModel(1);
  const c = createModel(7);
  const first = await weightsFingerprint(a);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await weightsFingerprint(b), first);
  assert.equal(first, sha256(a));
  assert.equal(await weightsFingerprint(c), sha256(c));
  assert.notEqual(first, await weightsFingerprint(c));
});

test('weight fingerprint matches the independent NumPy reference for seed 0', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8'));
  const caseZero = fixture.cases.find((one) => one.seed === 0);
  assert.ok(caseZero, 'seed-zero reference case is present');
  assert.equal(await weightsFingerprint(createModel(0)), caseZero.weightsSha256);
});

test('seed 7 fingerprint is pinned to the independent NumPy digest', async () => {
  // The same constant is pinned in reference/test_decoder.py, so a regression
  // isolated to either language fails on that side of the comparison.
  assert.equal(
    await weightsFingerprint(createModel(7)),
    '75384d2cbebcc56fa5bd99495ef898bf64c2274426a9a42c7ac1a309a1ba11ce',
  );
});
