import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { runExperiment } from '../dist/packages/core/index.js';

const clientUrl = new URL('../apps/web/dist/apps/web/src/worker-client.js', import.meta.url);
const protocolUrl = new URL('../apps/web/dist/apps/web/src/worker-protocol.js', import.meta.url);
const input = { schemaVersion: 1, seed: 7, tokens: [1, 4, 2], fault: 'none' };
const numerical = await runExperiment(input);
const response = (id) => ({ kind: 'result', id, result: numerical,
  timing: { fullForwardMs: 2, cachedDecoderMs: 3, totalMs: 9 }, executionContext: 'worker' });

async function setup(t) {
  assert.ok(existsSync(clientUrl), 'worker client must be built');
  const { ExperimentWorkerClient } = await import(clientUrl);
  const workers = [];
  const old = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class Transport {
    constructor(url, options) {
      this.url = url; this.options = options;
      this.onmessage = this.onerror = this.onmessageerror = null;
      this.terminated = 0;
      workers.push(this);
    }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated += 1; }
    reply(value) { this.onmessage?.({ data: value }); }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: Transport });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'Worker', old);
    else delete globalThis.Worker;
  });
  const client = new ExperimentWorkerClient();
  t.after(() => client.dispose());
  return { client, workers, Transport };
}
function cleaned(worker) {
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
}

test('client owns a same-origin module worker, clones input and measures lifetime before UI consumers', async (t) => {
  const { client, workers, Transport } = await setup(t);
  let clock = 10;
  globalThis.Worker = class extends Transport {
    constructor(...args) { clock += 4; super(...args); }
  };
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(Transport.prototype, 'postMessage', function (request) { clock += 5; this.request = request; });
  const mutable = structuredClone(input);
  const promise = client.run(mutable);
  mutable.tokens[0] = 9;
  const worker = workers[0];
  assert.equal(worker.url.pathname.endsWith('/apps/web/src/experiment-worker.js'), true);
  assert.deepEqual(worker.options, { type: 'module' });
  assert.deepEqual(worker.request, { kind: 'run', id: 1, input });
  clock += 12;
  worker.reply(response(1));
  clock += 1000; // DOM consumer delay is not part of round-trip.
  const result = await promise;
  assert.equal(result.roundTripMs, 21);
  assert.deepEqual(result.result, numerical);
  assert.deepEqual(result.timing, response(1).timing);
  cleaned(worker);
});

test('supersession rejects old promises, uses increasing IDs and ignores saved late callbacks', async (t) => {
  const { client, workers } = await setup(t);
  const first = client.run(input);
  const rejected = assert.rejects(first, { code: 'CANCELLED' });
  const late = workers[0].onmessage;
  const lateError = workers[0].onerror;
  const second = client.run(input);
  await rejected;
  cleaned(workers[0]);
  assert.equal(workers[1].request.id, 2);
  late({ data: response(1) });
  lateError({ message: 'C:/private/secret' });
  workers[1].reply(response(1)); // wrong id is not the matching response
  assert.equal(workers[1].terminated, 0);
  workers[1].reply(response(2));
  assert.deepEqual((await second).result, numerical);
  cleaned(workers[1]);
});

test('invalid later input cancels old work without evaluating getters or creating another worker', async (t) => {
  const { client, workers } = await setup(t);
  const first = client.run(input);
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  const bad = { ...input, get seed() { assert.fail('getter ran'); } };
  await assert.rejects(client.run(bad), { code: 'INPUT' });
  await cancelled;
  assert.equal(workers.length, 1);
  cleaned(workers[0]);
});

for (const failure of ['startup', 'post', 'runtime', 'messageerror', 'malformed', 'worker-error', 'timeout']) {
  test(`client cleans up ${failure} and recovers with a new worker`, async (t) => {
    const { client, workers, Transport } = await setup(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    if (failure === 'startup') globalThis.Worker = class { constructor() { throw Error('C:/secret'); } };
    if (failure === 'post') t.mock.method(Transport.prototype, 'postMessage', () => { throw Error('C:/secret'); });
    const promise = client.run(input);
    const rejected = assert.rejects(promise, (error) => {
      assert.match(error.code, /^WORKER_/);
      assert.doesNotMatch(error.message, /secret|stack|C:\//);
      return true;
    });
    const worker = workers[0];
    if (failure === 'runtime') worker.onerror({ message: 'C:/secret', preventDefault() {} });
    if (failure === 'messageerror') worker.onmessageerror({});
    if (failure === 'malformed') worker.reply({ ...response(1), timing: { fullForwardMs: NaN } });
    if (failure === 'worker-error') worker.reply({ kind: 'error', id: 1, error: { code: 'INTERNAL', message: 'C:/secret stack' } });
    if (failure === 'timeout') t.mock.timers.tick(30000);
    await rejected;
    if (worker) cleaned(worker);
    globalThis.Worker = Transport;
    t.mock.restoreAll();
    const recovery = client.run(input);
    const next = workers.at(-1);
    next.reply(response(next.request.id));
    assert.deepEqual((await recovery).result, numerical);
    cleaned(next);
  });
}

test('cancel/dispose terminate only this client, settle promises and reject use after disposal', async (t) => {
  const { client, workers } = await setup(t);
  const first = client.run(input);
  const rejected = assert.rejects(first, { code: 'CANCELLED' });
  client.cancel();
  await rejected;
  cleaned(workers[0]);
  const next = client.run(input);
  const disposed = assert.rejects(next, { code: 'CANCELLED' });
  client.dispose(); client.dispose();
  await disposed;
  cleaned(workers[1]);
  await assert.rejects(client.run(input), { code: 'DISPOSED' });
  assert.equal(workers.length, 2);
});

test('cancelling one client leaves a different owner active', async (t) => {
  const { client, workers } = await setup(t);
  const { ExperimentWorkerClient } = await import(clientUrl);
  const other = new ExperimentWorkerClient();
  t.after(() => other.dispose());
  const first = client.run(input);
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  const second = other.run(input);
  client.dispose();
  await cancelled;
  cleaned(workers[0]);
  assert.equal(workers[1].terminated, 0);
  workers[1].reply(response(1));
  assert.deepEqual((await second).result, numerical);
  cleaned(workers[1]);
});

test('protocol rejects unsafe request envelopes and malformed success/error messages', async () => {
  assert.ok(existsSync(protocolUrl), 'worker protocol must be built');
  const { parseWorkerRequest, parseWorkerResponse, safeWorkerError } = await import(protocolUrl);
  assert.deepEqual(safeWorkerError(new Error('C:/private/stack')), {
    code: 'INTERNAL', message: 'Worker computation failed.',
  });
  assert.deepEqual(parseWorkerRequest({ kind: 'run', id: 1, input }), { kind: 'run', id: 1, input });
  for (const id of [0, -1, 1.2, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseWorkerRequest({ kind: 'run', id, input }));
  }
  for (const value of [null, {}, { kind: 'run', id: 1, input, extra: 1 },
    { kind: 'run', id: 1, get input() { assert.fail('getter ran'); } }]) {
    assert.throws(() => parseWorkerRequest(value));
  }
  assert.deepEqual(parseWorkerResponse(response(1)), response(1));
  for (const value of [null, {}, { ...response(1), executionContext: 'main' },
    { ...response(1), result: {} }, { ...response(1), timing: { fullForwardMs: 5, cachedDecoderMs: 5, totalMs: 1 } },
    { kind: 'error', id: 1, error: { code: 5, message: 'bad' } }]) {
    assert.throws(() => parseWorkerResponse(value));
  }
});
