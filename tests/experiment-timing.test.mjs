import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import * as core from '../dist/packages/core/index.js';
import { FAULTS } from '../dist/packages/contracts/index.js';

const inputFor = (fault = 'none') => ({ schemaVersion: 1, seed: 7, tokens: [1, 4, 2, 8, 3, 9], fault });
const hashes = [
  '5bd1df73b8ea7bc0cc8f56ea6cae8ed3ace0069dae345f9c67347da54ff5382e',
  '7d03f7dc46d5f343305c29ced1adb74f220e32493f21b06d4ec2e2cefecdef00',
  '903ec24e66d4b1a1aadc104476e6b6b13d40954523bbb4463e4144eeab5efd33',
  '3c973944cffdaedb8eb6ccc0c604df8365456ea2a22f74e1e3b56f96bd12cadc',
  '1c6e86d974eb43a20cab4fea3d1c322e26de1f7df68f230d101754d76d773bb7',
];
function timedRunner() {
  assert.equal(typeof core.runTimedExperiment, 'function', 'core must export runTimedExperiment');
  return core.runTimedExperiment;
}
for (const [index, fault] of FAULTS.entries()) {
  test(`timing is an outer envelope; full/light and legacy JSON agree: ${fault}`, async () => {
    const run = timedRunner();
    for (const options of [undefined, { detail: 'full' }, { detail: 'light', topK: 1 }]) {
      const normal = await core.runExperiment(inputFor(fault), options);
      const timed = await run(inputFor(fault), options);
      assert.deepEqual(timed.result, normal);
      assert.deepEqual(Object.keys(timed).sort(), ['result', 'timing']);
      assert.deepEqual(Object.keys(timed.timing).sort(), ['cachedDecoderMs', 'fullForwardMs', 'totalMs']);
      for (const value of Object.values(timed.timing)) assert.ok(Number.isFinite(value) && value > 0);
      assert.ok(timed.timing.totalMs >= timed.timing.fullForwardMs + timed.timing.cachedDecoderMs);
      assert.equal(Object.hasOwn(normal, 'timing'), false);
      if (options?.detail !== 'light') {
        assert.equal(createHash('sha256').update(JSON.stringify(timed.result)).digest('hex'), hashes[index]);
      }
    }
  });
}

test('clock boundaries exclude comparison and snapshot work from both numerical kernels', async (t) => {
  const run = timedRunner();
  let clock = 0;
  const exp = Math.exp;
  const abs = Math.abs;
  // Real kernels still execute: each exponential costs one synthetic tick;
  // comparisons cost 100 ticks per abs, making misbilling observable.
  t.mock.method(Math, 'exp', (x) => { clock += 1; return exp(x); });
  t.mock.method(Math, 'abs', (x) => { clock += 100; return abs(x); });
  t.mock.method(performance, 'now', () => clock);
  const input = inputFor();
  core.fullForward(core.createModel(input.seed), input.tokens);
  const fullCost = clock;
  clock = 0;
  let cachedCost = 0;
  const step = core.CachedDecoder.prototype.step;
  const snapshot = core.CachedDecoder.prototype.snapshot;
  t.mock.method(core.CachedDecoder.prototype, 'step', function (token) {
    const before = clock;
    const result = step.call(this, token);
    cachedCost += clock - before;
    return result;
  });
  t.mock.method(core.CachedDecoder.prototype, 'snapshot', function () {
    clock += 500;
    return snapshot.call(this);
  });
  const measured = await run(input);
  assert.ok(fullCost > 0 && cachedCost > 0);
  assert.equal(measured.timing.fullForwardMs, fullCost);
  assert.equal(measured.timing.cachedDecoderMs, cachedCost);
  assert.equal(measured.timing.totalMs, clock);
  assert.ok(clock > fullCost + cachedCost + 500);
});

test('default, full, light, replay and expansion never consult a timer', async (t) => {
  const report = await core.runExperiment(inputFor());
  t.mock.method(performance, 'now', () => { assert.fail('untimed API read the clock'); });
  for (const options of [undefined, { detail: 'full' }, { detail: 'light' }]) {
    const result = await core.runExperiment(inputFor(), options);
    assert.equal(Object.hasOwn(result, 'timing'), false);
  }
  assert.deepEqual(await core.replayExperiment(report), report);
  assert.deepEqual(await core.expandExperimentStep(inputFor(), 3), report.steps[3]);
});

test('timed API retains input/options rejection', async () => {
  const run = timedRunner();
  await assert.rejects(() => run(null), { code: 'INPUT' });
  await assert.rejects(() => run(inputFor(), { detail: 'full', topK: 1 }), { code: 'INPUT' });
});

test('timed overloads retain exact full, light and optional-union result types', () => {
  const filename = fileURLToPath(new URL('./experiment-timing-types.mts', import.meta.url)).replaceAll('\\', '/');
  const source = `
    import { runTimedExperiment } from '../dist/packages/core/index.js';
    import type { ExperimentResult, LightExperimentResult, ExperimentOptions,
      ExperimentTiming, TimedExperimentResult } from '../dist/packages/core/index.js';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Expect<T extends true> = T;
    const full = runTimedExperiment({});
    const explicit = runTimedExperiment({}, { detail: 'full' });
    const omitted = runTimedExperiment({}, undefined);
    const light = runTimedExperiment({}, { detail: 'light', topK: 2 });
    declare const options: ExperimentOptions | undefined;
    const union = runTimedExperiment({}, options);
    type Checks = [
      Expect<Equal<typeof full, Promise<TimedExperimentResult<ExperimentResult>>>>,
      Expect<Equal<typeof explicit, typeof full>>,
      Expect<Equal<typeof omitted, typeof full>>,
      Expect<Equal<typeof light, Promise<TimedExperimentResult<LightExperimentResult>>>>,
      Expect<Equal<typeof union, Promise<TimedExperimentResult<ExperimentResult | LightExperimentResult>>>>,
      Expect<Equal<Awaited<typeof full>['timing'], ExperimentTiming>>
    ];
    // @ts-expect-error light results have no full logits
    (await light).result.steps[0].fullLogits;
    // @ts-expect-error timing is never inside the deterministic report
    (await full).result.timing;
    // @ts-expect-error full options forbid topK
    runTimedExperiment({}, { detail: 'full', topK: 1 });
  `;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
    exactOptionalPropertyTypes: true, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => name === filename
    ? ts.createSourceFile(name, source, version, true) : original(name, version, onError, fresh);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});
