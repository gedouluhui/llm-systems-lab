import assert from 'node:assert/strict';
import test from 'node:test';
import { CachedDecoder, createModel, fullForward } from '../dist/packages/core/index.js';
import { LabError } from '../dist/packages/contracts/index.js';

const MODEL = createModel(7);
const TOKENS = [1, 4, 2, 8, 3, 9];
const FAULTS = ['position-offset', 'cache-overwrite', 'mask-current-only'];

function close(actual, expected, label) {
  assert.ok(Number.isFinite(actual), `${label}: actual is not finite`);
  assert.ok(Number.isFinite(expected), `${label}: reference is not finite`);
  assert.ok(Math.abs(actual - expected) <= 1e-5 + 1e-4 * Math.abs(expected),
    `${label}: ${actual} vs ${expected}`);
}

function closeRows(actual, expected, offset, width, label) {
  for (let index = 0; index < width; index += 1) {
    close(actual[index], expected[offset + index], `${label}[${index}]`);
  }
}

function runSequence(decoder, tokens) {
  return tokens.map((token) => decoder.step(token));
}

test('fullForward returns shaped, finite logits, hidden states and caches', () => {
  assert.equal(typeof fullForward, 'function', 'fullForward is unavailable');
  const result = fullForward(MODEL, TOKENS);
  const length = TOKENS.length;
  assert.ok(result.logits instanceof Float32Array, 'logits must be Float32Array');
  assert.equal(result.logits.length, length * 32);
  assert.ok(Array.from(result.logits).every(Number.isFinite));
  assert.equal(result.hidden.length, 2);
  for (const layer of result.hidden) {
    assert.ok(layer instanceof Float32Array);
    assert.equal(layer.length, length * 16);
    assert.ok(Array.from(layer).every(Number.isFinite));
  }
  assert.equal(result.cache.length, 2);
  for (const layer of result.cache) {
    assert.ok(layer.keys instanceof Float32Array);
    assert.ok(layer.values instanceof Float32Array);
    assert.equal(layer.keys.length, length * 16);
    assert.equal(layer.values.length, length * 16);
    assert.ok(Array.from(layer.keys).every(Number.isFinite));
    assert.ok(Array.from(layer.values).every(Number.isFinite));
  }
});

test('fullForward is causally stable: a longer suffix does not change earlier rows', () => {
  const short = fullForward(MODEL, [1, 2, 3]);
  const long = fullForward(MODEL, [1, 2, 3, 4, 5]);
  assert.deepEqual(short.logits, long.logits.subarray(0, 3 * 32));
  for (let layer = 0; layer < 2; layer += 1) {
    assert.deepEqual(short.hidden[layer], long.hidden[layer].subarray(0, 3 * 16));
    assert.deepEqual(short.cache[layer].keys, long.cache[layer].keys.subarray(0, 3 * 16));
    assert.deepEqual(short.cache[layer].values, long.cache[layer].values.subarray(0, 3 * 16));
  }
});

test('cached steps match the full-prefix computation at every position', () => {
  assert.equal(typeof CachedDecoder, 'function', 'CachedDecoder is unavailable');
  const reference = fullForward(MODEL, TOKENS);
  const decoder = new CachedDecoder(MODEL);
  for (const [position, token] of TOKENS.entries()) {
    const step = decoder.step(token);
    assert.equal(step.position, position);
    assert.equal(step.token, token);
    assert.equal(step.logits.length, 32);
    assert.equal(step.hidden.length, 2);
    closeRows(step.logits, reference.logits, position * 32, 32, `logits@${position}`);
    for (let layer = 0; layer < 2; layer += 1) {
      closeRows(step.hidden[layer], reference.hidden[layer], position * 16, 16,
        `hidden${layer}@${position}`);
      const snapshot = decoder.snapshot();
      closeRows(snapshot[layer].keys.subarray(position * 16, (position + 1) * 16),
        reference.cache[layer].keys, position * 16, 16, `keys${layer}@${position}`);
      closeRows(snapshot[layer].values.subarray(position * 16, (position + 1) * 16),
        reference.cache[layer].values, position * 16, 16, `values${layer}@${position}`);
    }
    assert.equal(step.cacheEvents.length, 2);
    for (const [layer, event] of step.cacheEvents.entries()) {
      assert.equal(event.layer, layer);
      assert.equal(event.writeSlot, position);
      assert.equal(event.overwrittenSlot, null);
      assert.deepEqual(event.readSlots, Array.from({ length: position + 1 }, (_, index) => index));
    }
  }
  assert.equal(decoder.length, TOKENS.length);
});

test('cache snapshots are defensive copies', () => {
  const decoder = new CachedDecoder(MODEL);
  for (const token of [1, 4, 2]) decoder.step(token);
  const reference = fullForward(MODEL, [1, 4, 2]);
  const first = decoder.snapshot();
  assert.deepEqual(Array.from(first[0].keys), Array.from(reference.cache[0].keys));
  first[0].keys.fill(99);
  first[0].values[0] = -99;
  first[0].length = 0;
  const second = decoder.snapshot();
  assert.equal(second[0].length, 3);
  assert.deepEqual(Array.from(second[0].keys), Array.from(reference.cache[0].keys));
  assert.equal(second[0].values[0], reference.cache[0].values[0]);
});

test('independent decoders do not share cache state', () => {
  const left = new CachedDecoder(MODEL);
  const right = new CachedDecoder(MODEL);
  const leftSteps = runSequence(left, [1, 2, 3]);
  const rightSteps = runSequence(right, [8, 9]);
  const leftReference = fullForward(MODEL, [1, 2, 3]);
  const rightReference = fullForward(MODEL, [8, 9]);
  for (const [position, step] of leftSteps.entries()) {
    closeRows(step.logits, leftReference.logits, position * 32, 32, `left@${position}`);
  }
  for (const [position, step] of rightSteps.entries()) {
    closeRows(step.logits, rightReference.logits, position * 32, 32, `right@${position}`);
  }
});

test('reset clears only the calling decoder and reproduces the first step', () => {
  const decoder = new CachedDecoder(MODEL);
  const other = new CachedDecoder(MODEL);
  const first = decoder.step(1);
  for (const token of [4, 2, 8]) decoder.step(token);
  other.step(3);
  decoder.reset();
  assert.equal(decoder.length, 0);
  assert.equal(decoder.snapshot()[0].length, 0);
  assert.equal(other.length, 1);
  const again = decoder.step(1);
  assert.deepEqual(again.logits, first.logits);
  assert.deepEqual(again.hidden, first.hidden);
});

test('invalid tokens and context overflow leave the cache untouched', () => {
  const decoder = new CachedDecoder(MODEL);
  decoder.step(1);
  decoder.step(4);
  const before = decoder.snapshot();
  const badTokens = [32, -1, 1.5, NaN, Infinity, -Infinity, '1', true, null, undefined, {}, [], new Number(1)];
  for (const token of badTokens) {
    assert.throws(() => decoder.step(token), (error) => {
      assert.ok(error instanceof LabError, `token ${String(token)}`);
      assert.equal(error.code, 'INPUT');
      return true;
    });
    assert.equal(decoder.length, 2);
    assert.deepEqual(decoder.snapshot(), before);
  }
  const context = new CachedDecoder(MODEL);
  const zeros = Array.from({ length: 64 }, () => 0);
  for (const token of zeros) context.step(token);
  assert.throws(() => context.step(0), (error) => {
    assert.ok(error instanceof LabError);
    assert.equal(error.code, 'CONTEXT_LIMIT');
    return true;
  });
  assert.equal(context.length, 64);
});

test('unknown fault modes are rejected at construction', () => {
  for (const fault of ['bogus', '', 'NONE', null, undefined, 5]) {
    assert.throws(() => new CachedDecoder(MODEL, fault), (error) => {
      assert.ok(error instanceof LabError, `fault ${String(fault)}`);
      assert.equal(error.code, 'INPUT');
      return true;
    });
  }
});

test('teaching faults agree at position 0 and diverge later on a nontrivial sequence', () => {
  const normal = runSequence(new CachedDecoder(MODEL), TOKENS);
  for (const fault of FAULTS) {
    const decoder = new CachedDecoder(MODEL, fault);
    const faulty = runSequence(decoder, TOKENS);
    assert.deepEqual(faulty[0].logits, normal[0].logits, `${fault} must agree at position 0`);
    assert.deepEqual(faulty[0].hidden, normal[0].hidden, `${fault} hidden at position 0`);
    let diverged = false;
    for (let position = 1; position < TOKENS.length; position += 1) {
      for (let index = 0; index < 32; index += 1) {
        const difference = Math.abs(faulty[position].logits[index] - normal[position].logits[index]);
        if (difference > 1e-5 + 1e-4 * Math.abs(normal[position].logits[index])) {
          diverged = true;
          break;
        }
      }
      if (diverged) break;
    }
    assert.ok(diverged, `${fault} must produce an observable divergence after position 0`);
  }
});

test('fault events expose the corrupted write and the narrowed read set', () => {
  const overwrite = new CachedDecoder(MODEL, 'cache-overwrite');
  const first = overwrite.step(1);
  assert.equal(first.cacheEvents[0].overwrittenSlot, null);
  const second = overwrite.step(4);
  for (const event of second.cacheEvents) {
    assert.equal(event.overwrittenSlot, 0);
    assert.equal(event.writeSlot, 1);
    assert.deepEqual(event.readSlots, [0, 1]);
  }
  const masked = new CachedDecoder(MODEL, 'mask-current-only');
  for (const [position, token] of TOKENS.entries()) {
    const step = masked.step(token);
    for (const event of step.cacheEvents) {
      assert.deepEqual(event.readSlots, [position]);
    }
  }
});

test('a fresh normal decoder recovers after faulty runs', () => {
  for (const fault of FAULTS) {
    runSequence(new CachedDecoder(MODEL, fault), TOKENS);
  }
  const recovered = runSequence(new CachedDecoder(MODEL), TOKENS);
  const reference = fullForward(MODEL, TOKENS);
  for (const [position, step] of recovered.entries()) {
    closeRows(step.logits, reference.logits, position * 32, 32, `recovered@${position}`);
  }
});
