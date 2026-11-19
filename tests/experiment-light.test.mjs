import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { FAULTS, LabError, MODEL_SPEC } from '../dist/packages/contracts/index.js';
import * as core from '../dist/packages/core/index.js';

const normalInput = (fault = 'none') => ({
  schemaVersion: 1,
  seed: 7,
  tokens: [1, 4, 2, 8, 3, 9],
  fault,
});

function labError(code) {
  return (error) => {
    assert.ok(error instanceof LabError);
    assert.equal(error.code, code);
    return true;
  };
}

function requireExport(name) {
  assert.equal(typeof core[name], 'function', `${name} must be exported by core`);
  return core[name];
}

// An independent oracle: rank the full report, not the production TopK helper.
function ranked(logits, k) {
  return logits.map((logit, tokenId) => ({ tokenId, logit }))
    .sort((a, b) => b.logit - a.logit || a.tokenId - b.tokenId)
    .slice(0, k);
}

function assertLightParity(light, full, k) {
  assert.equal(light.detail, 'light');
  assert.equal(light.topK, k);
  const { steps, finalCache, ...metadata } = full;
  assert.deepEqual(light, {
    ...metadata,
    detail: 'light',
    topK: k,
    steps: steps.map(({ fullLogits, cachedLogits, ...step }) => ({
      ...step,
      logitsLength: MODEL_SPEC.vocabSize,
      fullTopK: ranked(fullLogits, k),
      cachedTopK: ranked(cachedLogits, k),
    })),
    finalCache: finalCache.map(({ layer, rows }) => ({
      layer,
      rows,
      columns: MODEL_SPEC.modelDim,
    })),
  });
  for (const step of light.steps) {
    assert.notStrictEqual(step.fullTopK, step.cachedTopK, 'rankings are independent arrays');
    assert.equal(step.logits.length, MODEL_SPEC.vocabSize, 'compare all logits, not just TopK');
    assert.equal(step.hidden.length, MODEL_SPEC.numLayers);
    for (const layer of step.hidden) {
      assert.equal(layer.comparison.length, MODEL_SPEC.modelDim);
    }
  }
  assert.equal(light.comparison.cache.length,
    full.input.tokens.length * MODEL_SPEC.modelDim * MODEL_SPEC.numLayers * 2);
}

test('topKLogits ranks hand-computed ties by token id without changing input', () => {
  const topKLogits = requireExport('topKLogits');
  const values = [-3, 2, 2, 0, -1, 2];
  const expected = [
    { tokenId: 1, logit: 2 },
    { tokenId: 2, logit: 2 },
    { tokenId: 5, logit: 2 },
    { tokenId: 3, logit: 0 },
    { tokenId: 4, logit: -1 },
    { tokenId: 0, logit: -3 },
  ];
  for (const vector of [Object.freeze([...values]), new Float32Array(values), new Float64Array(values)]) {
    const before = Array.from(vector);
    for (const k of [1, 2, 5, 6]) {
      assert.deepEqual(topKLogits(vector, k), expected.slice(0, k));
    }
    assert.deepEqual(Array.from(vector), before);
  }
  assert.deepEqual(topKLogits([-0, 0, -0], 3), [
    { tokenId: 0, logit: 0 }, { tokenId: 1, logit: 0 }, { tokenId: 2, logit: 0 },
  ], 'normalize negative zero consistently with full reports');
  assert.deepEqual(topKLogits([-5, -2, -3], 2), [
    { tokenId: 1, logit: -2 }, { tokenId: 2, logit: -3 },
  ]);
  assert.deepEqual(topKLogits([Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE], 2), [
    { tokenId: 0, logit: Number.MAX_VALUE }, { tokenId: 2, logit: Number.MAX_VALUE },
  ]);
});

test('topKLogits rejects invalid k rather than clamping or coercing it', () => {
  const topKLogits = requireExport('topKLogits');
  for (const k of [undefined, null, 0, -0, -1, 1.5, 4, NaN, Infinity, -Infinity, '2', true, 1n, {}]) {
    assert.throws(() => topKLogits([1, 2, 3], k), labError('INPUT'), `k=${String(k)}`);
  }
});

test('topKLogits validates the entire nonempty numeric vector, including unselected values', () => {
  const topKLogits = requireExport('topKLogits');
  for (const vector of [undefined, null, 3, '12', {}, { 0: 1, length: 1 }, [],
    new Float32Array(), new Float64Array(), [1, '2'], [1, null], [1, undefined], [1, true],
    [1, 2n], new Array(2), [1, , 2]]) {
    assert.throws(() => topKLogits(vector, 1), labError('INPUT'));
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const vector of [[10, value], new Float32Array([10, value]), new Float64Array([10, value])]) {
      assert.throws(() => topKLogits(vector, 1), labError('NON_FINITE'));
    }
  }
});

test('runExperiment rejects malformed options, unknown detail, and topK in full mode', async () => {
  for (const options of [null, false, 5, 'light', [], new Date(), {},
    { detail: undefined }, { detail: null }, { detail: 'unknown' }, { detail: 'numerical' },
    { topK: 5 }, { detail: 'full', topK: 5 }, { detail: 'full', topK: undefined },
    { detail: 'light', extra: true }, { detail: 'full', extra: true },
    { detail: 'light', [Symbol('extra')]: true },
    Object.create({ detail: 'light' })]) {
    await assert.rejects(() => core.runExperiment(normalInput(), options), labError('INPUT'));
  }
  for (const topK of [undefined, null, 0, -1, 1.5, 33, NaN, Infinity, -Infinity, '5', true, 1n, {}]) {
    await assert.rejects(() => core.runExperiment(normalInput(), { detail: 'light', topK }), labError('INPUT'));
  }
  let getterCalls = 0;
  for (const name of ['detail', 'topK']) {
    const options = { detail: 'light' };
    Object.defineProperty(options, name, { get() { getterCalls += 1; return name === 'detail' ? 'light' : 5; } });
    await assert.rejects(() => core.runExperiment(normalInput(), options), labError('INPUT'));
  }
  assert.equal(getterCalls, 0, 'options must be plain data, not execute accessors');
});

// Captured from the unchanged full implementation before this feature was added.
const fullJsonHashes = {
  none: '5bd1df73b8ea7bc0cc8f56ea6cae8ed3ace0069dae345f9c67347da54ff5382e',
  'position-offset': '7d03f7dc46d5f343305c29ced1adb74f220e32493f21b06d4ec2e2cefecdef00',
  'cache-overwrite': '903ec24e66d4b1a1aadc104476e6b6b13d40954523bbb4463e4144eeab5efd33',
  'mask-current-only': '3c973944cffdaedb8eb6ccc0c604df8365456ea2a22f74e1e3b56f96bd12cadc',
  'no-cache-recompute': '1c6e86d974eb43a20cab4fea3d1c322e26de1f7df68f230d101754d76d773bb7',
};

for (const fault of FAULTS) {
  test(`default and explicit full preserve existing JSON: ${fault}`, async () => {
    const input = normalInput(fault);
    const full = await core.runExperiment(input);
    const explicit = await core.runExperiment(input, { detail: 'full' });
    assert.deepEqual(explicit, full);
    assert.equal(JSON.stringify(explicit), JSON.stringify(full));
    assert.deepEqual(await core.runExperiment(input, undefined), full);
    assert.equal(createHash('sha256').update(JSON.stringify(full)).digest('hex'), fullJsonHashes[fault]);
    assert.equal(Object.hasOwn(full, 'detail'), false);
    assert.equal(Object.hasOwn(full, 'topK'), false);
  });

  for (const [seed, length] of [[0, 1], [7, 6], [4294967295, 17], [7, 64]]) {
    test(`light/full comparisons, metadata, shapes and work agree: ${fault}, seed=${seed}, length=${length}`, async () => {
      const input = Object.freeze({
        schemaVersion: 1,
        seed,
        tokens: Object.freeze(Array.from({ length }, (_, position) => position % MODEL_SPEC.vocabSize)),
        fault,
      });
      const full = await core.runExperiment(input);
      for (const options of [{ detail: 'light' }, { detail: 'light', topK: 1 }, { detail: 'light', topK: 32 }]) {
        const light = await core.runExperiment(input, Object.freeze(options));
        assertLightParity(light, full, options.topK ?? 5);
        assert.deepEqual(JSON.parse(JSON.stringify(light)), light, 'report is JSON-safe');
        if (light.topK === 32) {
          for (let position = 0; position < length; position += 1) {
            for (const [ranking, logits] of [['fullTopK', 'fullLogits'], ['cachedTopK', 'cachedLogits']]) {
              const restored = [...light.steps[position][ranking]].sort((a, b) => a.tokenId - b.tokenId)
                .map((entry) => entry.logit);
              assert.deepEqual(restored, full.steps[position][logits]);
            }
          }
        }
      }
    });
  }

  test(`expand replays history and returns the identical first, middle and last full step: ${fault}`, async () => {
    const expandExperimentStep = requireExport('expandExperimentStep');
    const input = normalInput(fault);
    const full = await core.runExperiment(input);
    for (const position of [0, 3, 5]) {
      assert.deepEqual(await expandExperimentStep(input, position), full.steps[position]);
    }
    const longInput = { ...input, tokens: Array.from({ length: 64 }, (_, i) => i % 32) };
    const longFull = await core.runExperiment(longInput);
    assert.deepEqual(await expandExperimentStep(longInput, 63), longFull.steps[63]);
  });
}

test('light preserves mismatch coordinates outside Top1 and errors over all cache values', async () => {
  const full = await core.runExperiment(normalInput('cache-overwrite'));
  const light = await core.runExperiment(normalInput('cache-overwrite'), { detail: 'light', topK: 1 });
  assertLightParity(light, full, 1);
  assert.ok(full.steps.some((step) => step.logits.firstMismatch !== null
    && !ranked(step.fullLogits, 1).some((entry) => entry.tokenId === step.logits.firstMismatch)
    && !ranked(step.cachedLogits, 1).some((entry) => entry.tokenId === step.logits.firstMismatch)));
  assert.equal(light.comparison.passes, false);
  assert.equal(light.comparison.cache.passes, false);
  assert.equal(light.comparison.firstDivergence, full.comparison.firstDivergence);
  assert.equal(light.comparison.maxAbsoluteError, full.comparison.maxAbsoluteError);
  assert.equal(light.comparison.maxRelativeError, full.comparison.maxRelativeError);
});

test('expand rejects invalid positions and validates the complete input before replay', async () => {
  const expandExperimentStep = requireExport('expandExperimentStep');
  for (const position of [undefined, null, -1, 0.5, 6, NaN, Infinity, -Infinity, '0', false, 0n, {}]) {
    await assert.rejects(() => expandExperimentStep(normalInput(), position), labError('INPUT'));
  }
  for (const input of [null, {}, { ...normalInput(), tokens: [] },
    { ...normalInput(), tokens: [1, 99] }, { ...normalInput(), fault: 'unknown' },
    { ...normalInput(), detail: 'light' }, { ...normalInput(), topK: 5 }]) {
    await assert.rejects(() => expandExperimentStep(input, 0), labError('INPUT'));
    await assert.rejects(() => core.runExperiment(input, { detail: 'light' }), labError('INPUT'));
  }
  const tooLong = { ...normalInput(), tokens: Array(65).fill(0) };
  await assert.rejects(() => expandExperimentStep(tooLong, 0), labError('CONTEXT_LIMIT'));
  await assert.rejects(() => core.runExperiment(tooLong, { detail: 'light' }), labError('CONTEXT_LIMIT'));
  const input = { ...normalInput(), tokens: [3] };
  assert.deepEqual(await expandExperimentStep(input, -0), (await core.runExperiment(input)).steps[0]);
});

test('expand consumes exactly the requested prefix, not an isolated token or the suffix', async (t) => {
  const expandExperimentStep = requireExport('expandExperimentStep');
  const input = normalInput('cache-overwrite');
  const full = await core.runExperiment(input);
  const consumed = [];
  const step = core.CachedDecoder.prototype.step;
  t.mock.method(core.CachedDecoder.prototype, 'step', function (token) {
    consumed.push(token);
    return step.call(this, token);
  });
  const expanded = await expandExperimentStep(input, 3);
  assert.deepEqual(expanded, full.steps[3]);
  assert.deepEqual(consumed, input.tokens.slice(0, 4));
});

test('replay stays full even when the recorded report is light', async () => {
  const input = normalInput('position-offset');
  const light = await core.runExperiment(input, { detail: 'light' });
  assert.equal(light.detail, 'light');
  const full = await core.runExperiment(input);
  assert.deepEqual(await core.replayExperiment(JSON.parse(JSON.stringify(light))), full);
});

test('64-step seed-7 light JSON is smaller with identical work, not fewer forward computations', async (t) => {
  const input = { schemaVersion: 1, seed: 7, tokens: Array.from({ length: 64 }, (_, i) => i % 32), fault: 'none' };
  const full = await core.runExperiment(input);
  const light = await core.runExperiment(input, { detail: 'light', topK: 5 });
  assertLightParity(light, full, 5);
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  const lightBytes = Buffer.byteLength(JSON.stringify(light), 'utf8');
  t.diagnostic(`JSON UTF-8 bytes: full=${fullBytes}, light(k=5)=${lightBytes}`);
  assert.ok(lightBytes < fullBytes);
  assert.deepEqual(light.workSummary, full.workSummary);
});

test('TypeScript overloads preserve exact default/full, light, union and expanded result types', () => {
  const filename = fileURLToPath(new URL('./experiment-light-types.mts', import.meta.url)).replaceAll('\\', '/');
  const source = `
    import { runExperiment, expandExperimentStep, topKLogits, replayExperiment } from '../dist/packages/core/index.js';
    import type { ExperimentResult, ExperimentStep, LightExperimentResult, LightExperimentStep,
      LightFinalCacheLayer, TopKLogit, ExperimentOptions } from '../dist/packages/core/index.js';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Expect<T extends true> = T;
    declare const input: unknown;
    const defaultResult = runExperiment(input);
    const fullResult = runExperiment(input, { detail: 'full' });
    const omittedOptions = runExperiment(input, undefined);
    const lightResult = runExperiment(input, { detail: 'light', topK: 5 });
    const lightDefault = runExperiment(input, { detail: 'light' });
    declare const options: ExperimentOptions;
    const unionResult = runExperiment(input, options);
    declare const optionalOptions: ExperimentOptions | undefined;
    declare const optionalLight: { detail: 'light'; topK?: number } | undefined;
    const optionalUnionResult = runExperiment(input, optionalOptions);
    const optionalLightResult = runExperiment(input, optionalLight);
    const expanded = expandExperimentStep(input, 0);
    const replayed = replayExperiment(input);
    const top = topKLogits(new Float32Array([1]), 1);
    type Checks = [
      Expect<Equal<typeof defaultResult, Promise<ExperimentResult>>>,
      Expect<Equal<typeof fullResult, Promise<ExperimentResult>>>,
      Expect<Equal<typeof omittedOptions, Promise<ExperimentResult>>>,
      Expect<Equal<typeof lightResult, Promise<LightExperimentResult>>>,
      Expect<Equal<typeof lightDefault, Promise<LightExperimentResult>>>,
      Expect<Equal<typeof unionResult, Promise<ExperimentResult | LightExperimentResult>>>,
      Expect<Equal<typeof optionalUnionResult, Promise<ExperimentResult | LightExperimentResult>>>,
      Expect<Equal<typeof optionalLightResult, Promise<ExperimentResult | LightExperimentResult>>>,
      Expect<Equal<typeof expanded, Promise<ExperimentStep>>>,
      Expect<Equal<typeof replayed, Promise<ExperimentResult>>>,
      Expect<Equal<typeof top, TopKLogit[]>>,
      Expect<Equal<LightExperimentResult['steps'][number], LightExperimentStep>>,
      Expect<Equal<LightExperimentResult['finalCache'][number], LightFinalCacheLayer>>,
      Expect<Equal<LightExperimentResult['mode'], 'numerical'>>,
      Expect<Equal<LightExperimentResult['detail'], 'light'>>
    ];
    (await defaultResult).steps[0]!.fullLogits;
    // @ts-expect-error light results never carry full logits
    (await lightResult).steps[0]!.fullLogits;
    // @ts-expect-error light results never carry cache tensors
    (await lightResult).finalCache[0]!.keys;
    // @ts-expect-error full results never gain the light discriminant
    (await defaultResult).detail;
    // @ts-expect-error full mode forbids topK
    runExperiment(input, { detail: 'full', topK: 5 });
    // @ts-expect-error unknown detail is not accepted by a permissive overload
    runExperiment(input, { detail: 'other' });
    // @ts-expect-error null options are not accepted
    runExperiment(input, null);
  `;
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === filename
    ? ts.createSourceFile(name, source, languageVersion, true)
    : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});
