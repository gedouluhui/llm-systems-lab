import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../dist/packages/contracts/index.js';

const validInput = () => ({ schemaVersion: 1, seed: 0, tokens: [0, 31], fault: 'none' });
const faults = ['none', 'position-offset', 'cache-overwrite', 'mask-current-only'];

function api(name) {
  assert.equal(typeof contracts[name], 'function', `${name} must be available`);
  return contracts[name];
}

function rejects(action, code, label) {
  const LabError = api('LabError');
  assert.throws(action, (error) => {
    assert.ok(error instanceof LabError, label);
    assert.equal(error.code, code, label);
    return true;
  }, label);
}

test('validateInput is available and returns a defensive copy', () => {
  assert.equal(typeof contracts.validateInput, 'function', 'input validation is unavailable');
  const source = validInput();
  const validated = contracts.validateInput(source);
  assert.notStrictEqual(validated, source);
  assert.notStrictEqual(validated.tokens, source.tokens);
  source.tokens[0] = 9;
  source.seed = 7;
  source.fault = 'cache-overwrite';
  assert.deepEqual(validated, validInput());
  validated.tokens[1] = 8;
  assert.deepEqual(source.tokens, [9, 31]);
});

test('validateInput accepts all faults and inclusive seed, token, and context boundaries', () => {
  const validate = api('validateInput');
  for (const fault of faults) {
    for (const seed of [0, 1, 4294967295]) {
      for (const tokens of [[0], [31], Array.from({ length: 64 }, (_, i) => i % 32)]) {
        const source = Object.freeze({ schemaVersion: 1, seed, tokens: Object.freeze(tokens), fault });
        assert.deepEqual(validate(source), source);
      }
    }
  }
});

test('validateInput accepts data records with a null prototype', () => {
  const validate = api('validateInput');
  assert.deepEqual(validate(Object.assign(Object.create(null), validInput())), validInput());
});

test('LabError preserves distinct INPUT, CONTEXT_LIMIT, and NON_FINITE codes', () => {
  const LabError = api('LabError');
  for (const code of ['INPUT', 'CONTEXT_LIMIT', 'NON_FINITE']) {
    const error = new LabError(code, 'diagnostic');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'LabError');
    assert.equal(error.message, 'diagnostic');
    assert.equal(error.code, code);
  }
});

test('validateInput rejects primitives, arrays, built-ins, and class instances', () => {
  const validate = api('validateInput');
  class Input { constructor() { Object.assign(this, validInput()); } }
  const values = [undefined, null, true, false, 1, NaN, Infinity, 1n, '', 'input', Symbol('input'),
    () => validInput(), [], [validInput()], new Uint8Array([1]), new Date(), new Map(), new Set(),
    new Number(1), new String('input'), new Input()];
  for (const value of values) rejects(() => validate(value), 'INPUT', `input type ${typeof value}`);
});

test('validateInput rejects missing fields, including inherited replacements', () => {
  const validate = api('validateInput');
  rejects(() => validate({}), 'INPUT', 'empty record');
  for (const key of ['schemaVersion', 'seed', 'tokens', 'fault']) {
    const missing = validInput();
    delete missing[key];
    rejects(() => validate(missing), 'INPUT', `missing ${key}`);
    const inherited = Object.assign(Object.create({ [key]: validInput()[key] }), missing);
    rejects(() => validate(inherited), 'INPUT', `inherited ${key}`);
  }
});

test('validateInput rejects unknown string, symbol, and non-enumerable keys', () => {
  const validate = api('validateInput');
  for (const key of ['extra', '__proto__', 'constructor', Symbol('extra')]) {
    for (const enumerable of [true, false]) {
      const source = validInput();
      Object.defineProperty(source, key, { value: 1, enumerable });
      rejects(() => validate(source), 'INPUT', `unknown ${String(key)}`);
    }
  }
});

test('validateInput rejects wrong schema versions without coercion', () => {
  const validate = api('validateInput');
  for (const schemaVersion of [undefined, null, 0, 2, -1, 1.5, NaN, Infinity, true, '1', 1n,
    new Number(1), [], {}, Symbol('version'), () => 1]) {
    rejects(() => validate({ ...validInput(), schemaVersion }), 'INPUT', `schema ${typeof schemaVersion}`);
  }
});

test('validateInput rejects unknown or non-string fault modes', () => {
  const validate = api('validateInput');
  for (const fault of [undefined, null, '', 'NONE', 'none ', 'unknown', 0, 1, NaN, true, 1n,
    ['none'], new String('none'), {}, Symbol('none'), () => 'none']) {
    rejects(() => validate({ ...validInput(), fault }), 'INPUT', `fault ${typeof fault}`);
  }
});

test('validateSeed accepts uint32 boundaries including zero without truncation', () => {
  const validate = api('validateSeed');
  for (const seed of [0, 1, 7, 42, 2147483648, 4294967295]) assert.equal(validate(seed), seed);
});

test('validateSeed and validateInput reject invalid seed types and bounds', () => {
  const validateSeed = api('validateSeed');
  const validateInput = api('validateInput');
  for (const seed of [undefined, null, true, false, '0', '1', '', 0n, 1n, [], [1], {},
    new Number(1), Symbol('seed'), () => 1, -1, -0.1, 0.5, 4294967296,
    Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity]) {
    rejects(() => validateSeed(seed), 'INPUT', `seed ${typeof seed}`);
    rejects(() => validateInput({ ...validInput(), seed }), 'INPUT', `input seed ${typeof seed}`);
  }
});

test('validateTokens returns a fresh dense copy and never mutates a frozen source', () => {
  const validate = api('validateTokens');
  const source = Object.freeze([0, 31]);
  const first = validate(source);
  const second = validate(source);
  assert.deepEqual(first, [0, 31]);
  assert.notStrictEqual(first, source);
  assert.notStrictEqual(first, second);
  first[0] = 8;
  assert.deepEqual(source, [0, 31]);
  assert.deepEqual(second, [0, 31]);
  assert.equal(validate(Array(64).fill(31)).length, 64);
});

test('token validators reject empty arrays and non-array containers', () => {
  const validateTokens = api('validateTokens');
  const validateInput = api('validateInput');
  for (const tokens of [[], undefined, null, 0, 1, true, false, '', '1,2', 1n, {},
    { 0: 1, length: 1 }, new Set([1]), new Uint8Array([1]), new Float32Array([1]),
    Symbol('tokens'), () => [1]]) {
    rejects(() => validateTokens(tokens), 'INPUT', `tokens ${typeof tokens}`);
    rejects(() => validateInput({ ...validInput(), tokens }), 'INPUT', `input tokens ${typeof tokens}`);
  }
});

test('token validators reject non-integers, coercible objects, and out-of-vocabulary values', () => {
  const validateTokens = api('validateTokens');
  const validateInput = api('validateInput');
  const coercible = { valueOf() { throw new Error('must not coerce tokens'); } };
  for (const token of [-1, 32, 4294967296, Number.MAX_SAFE_INTEGER, 1.5, NaN, Infinity, -Infinity,
    true, false, null, undefined, '1', '', 1n, new Number(1), [], [1], {}, coercible,
    Symbol('token'), () => 1]) {
    for (const tokens of [[token], [0, token, 31]]) {
      rejects(() => validateTokens(tokens), 'INPUT', `token ${typeof token}`);
      rejects(() => validateInput({ ...validInput(), tokens }), 'INPUT', `input token ${typeof token}`);
    }
  }
});

test('token validators reject sparse arrays even when a prototype fills a hole', () => {
  const validateTokens = api('validateTokens');
  const validateInput = api('validateInput');
  const inherited = Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 1 }));
  for (const tokens of [Array(1), [0, , 31], inherited]) {
    rejects(() => validateTokens(tokens), 'INPUT', 'sparse tokens');
    rejects(() => validateInput({ ...validInput(), tokens }), 'INPUT', 'sparse input tokens');
  }
});

test('token validators distinguish context overflow from other INPUT failures', () => {
  const validateTokens = api('validateTokens');
  const validateInput = api('validateInput');
  for (const length of [65, 128]) {
    const tokens = Array(length).fill(1);
    rejects(() => validateTokens(tokens), 'CONTEXT_LIMIT', `length ${length}`);
    rejects(() => validateInput({ ...validInput(), tokens }), 'CONTEXT_LIMIT', `input length ${length}`);
  }
});

test('token validators reject extra array properties and accessor elements without evaluating them', () => {
  const validateTokens = api('validateTokens');
  const validateInput = api('validateInput');
  const extra = Object.assign([1], { extra: true });
  const symbol = Object.assign([1], { [Symbol('extra')]: true });
  const hidden = Object.defineProperty([1], 'extra', { value: true });
  const accessor = Object.defineProperty([1], '0', { get() { throw new Error('must not read getter'); } });
  for (const tokens of [extra, symbol, hidden, accessor]) {
    rejects(() => validateTokens(tokens), 'INPUT', 'non-data tokens');
    rejects(() => validateInput({ ...validInput(), tokens }), 'INPUT', 'non-data input tokens');
  }
});

test('validateInput rejects accessor fields without evaluating user code', () => {
  const validate = api('validateInput');
  for (const key of ['schemaVersion', 'seed', 'tokens', 'fault']) {
    const source = validInput();
    Object.defineProperty(source, key, { get() { throw new Error('must not read getter'); } });
    rejects(() => validate(source), 'INPUT', `accessor ${key}`);
  }
});

test('frozen MODEL_SPEC and FAULTS preserve the numerical validation contract', () => {
  api('validateInput');
  assert.deepEqual(contracts.MODEL_SPEC, {
    id: 'tiny-decoder-v1', vocabSize: 32, maxContext: 64, numLayers: 2, numHeads: 2,
    headDim: 8, modelDim: 16, ffDim: 32, layerNormEpsilon: 1e-5,
  });
  assert.deepEqual(contracts.FAULTS, faults);
  assert.ok(Object.isFrozen(contracts.MODEL_SPEC));
  assert.ok(Object.isFrozen(contracts.FAULTS));
  assert.throws(() => { contracts.MODEL_SPEC.maxContext = 65; }, TypeError);
  assert.throws(() => contracts.FAULTS.push('unknown'), TypeError);
});
