import assert from 'node:assert/strict';
import test from 'node:test';
import { PagePool } from '../dist/packages/simulator/index.js';
import { LabError } from '../dist/packages/contracts/index.js';

const BYTES_PER_TOKEN = 2 * 2 * 2 * 8 * 4;

function expectError(action, code, label) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof LabError, `${label}: expected LabError, got ${error}`);
    assert.equal(error.code, code, label);
    return true;
  });
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

test('known accounting example: 32 tokens, then 33 tokens with 16-token pages', () => {
  const pool = new PagePool(16, 4);
  pool.append('a', 32);
  assert.equal(pool.snapshot().logicalBytes, 8192);
  pool.append('a', 1);
  assert.equal(pool.snapshot().allocatedBytes, 12288);
  assert.equal(pool.snapshot().wasteBytes, 3840);

  const before = pool.snapshot();
  expectError(() => pool.append('a', 32), 'OOM', 'atomic OOM');
  assert.deepEqual(pool.snapshot(), before);
  assert.equal(pool.snapshot().logicalTokens, 33);
});

test('empty pool snapshot is valid and deterministic', () => {
  const pool = new PagePool(8, 4);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.pageSize, 8);
  assert.equal(snapshot.pageCount, 4);
  assert.equal(snapshot.bytesPerToken, BYTES_PER_TOKEN);
  assert.equal(snapshot.capacityTokens, 32);
  assert.equal(snapshot.capacityBytes, 32 * BYTES_PER_TOKEN);
  assert.equal(snapshot.logicalTokens, 0);
  assert.equal(snapshot.logicalBytes, 0);
  assert.equal(snapshot.allocatedPages, 0);
  assert.equal(snapshot.allocatedTokens, 0);
  assert.equal(snapshot.allocatedBytes, 0);
  assert.equal(snapshot.wasteTokens, 0);
  assert.equal(snapshot.wasteBytes, 0);
  assert.deepEqual(snapshot.freePages, [0, 1, 2, 3]);
  assert.deepEqual(snapshot.requests, []);
});

test('two one-token requests fragment into two whole pages', () => {
  const pool = new PagePool(16, 4);
  pool.append('a', 1);
  pool.append('b', 1);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.allocatedPages, 2);
  assert.equal(snapshot.allocatedTokens, 32);
  assert.equal(snapshot.allocatedBytes, 32 * BYTES_PER_TOKEN);
  assert.equal(snapshot.logicalTokens, 2);
  assert.equal(snapshot.wasteTokens, 30);
  assert.deepEqual(snapshot.freePages, [2, 3]);
  assert.equal(snapshot.requests.length, 2);
  const pages = snapshot.requests.flatMap((request) => request.pages);
  assert.equal(new Set(pages).size, 2, 'physical pages must not be shared');
  assert.deepEqual([...pages].sort((left, right) => left - right), [0, 1]);
});

test('release frees pages and later appends reuse the lowest free page', () => {
  const pool = new PagePool(4, 3);
  pool.append('a', 5);
  pool.append('b', 3);
  let snapshot = pool.snapshot();
  assert.deepEqual(snapshot.requests[0].pages, [0, 1]);
  assert.deepEqual(snapshot.requests[1].pages, [2]);
  assert.deepEqual(snapshot.freePages, []);

  const summary = pool.release('a');
  assert.equal(summary.id, 'a');
  assert.deepEqual(summary.releasedPages, [0, 1]);
  assert.equal(summary.releasedTokens, 5);
  snapshot = pool.snapshot();
  assert.deepEqual(snapshot.freePages, [0, 1]);
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].id, 'b');

  pool.append('c', 8);
  snapshot = pool.snapshot();
  assert.deepEqual(snapshot.requests[1].pages, [0, 1], 'lowest free pages are reused');
  assert.deepEqual(snapshot.freePages, []);

  const releasedB = pool.release('b');
  const releasedC = pool.release('c');
  assert.deepEqual(releasedB.releasedPages, [2]);
  assert.deepEqual(releasedC.releasedPages, [0, 1]);
  assert.deepEqual(pool.snapshot().freePages, [0, 1, 2]);

  const before = pool.snapshot();
  expectError(() => pool.release('a'), 'INPUT', 'double release');
  expectError(() => pool.release('missing'), 'INPUT', 'unknown release');
  assert.deepEqual(pool.snapshot(), before);
});

test('constructor and argument limits reject without creating state', () => {
  for (const [pageSize, pageCount] of [
    [0, 4], [65, 4], [16, 0], [16, 1025], [16.5, 4], ['16', 4], [NaN, 4],
    [16, 4.5], [16, '4'], [16, NaN], [Infinity, 4], [16, Infinity],
  ]) {
    expectError(() => new PagePool(pageSize, pageCount), 'INPUT', `pool ${String(pageSize)}x${String(pageCount)}`);
  }
  const edge = new PagePool(1, 1);
  assert.equal(edge.snapshot().capacityTokens, 1);
  const large = new PagePool(64, 1024);
  assert.equal(large.snapshot().capacityTokens, 64 * 1024);

  const pool = new PagePool(16, 4);
  const before = pool.snapshot();
  for (const id of ['', 'a'.repeat(65), 'a b', 'a/b', '中文', 5, null, undefined, {}]) {
    expectError(() => pool.append(id, 1), 'INPUT', `id ${String(id)}`);
  }
  for (const count of [0, -1, 1.5, NaN, Infinity, -Infinity, '1', true, null, undefined, 65]) {
    expectError(() => pool.append('a', count), 'INPUT', `count ${String(count)}`);
  }
  assert.deepEqual(pool.snapshot(), before);

  const allowed = new PagePool(16, 4);
  allowed.append('A', 1);
  allowed.append('z_9-', 1);
  allowed.append('x'.repeat(64), 1);
  assert.equal(allowed.snapshot().requests.length, 3);
});

test('snapshots and append results are defensive copies', () => {
  const pool = new PagePool(8, 4);
  const assignment = pool.append('a', 3);
  assignment.pages.push(99);
  assignment.pages[0] = -1;
  const first = pool.snapshot();
  first.requests[0].pages.push(98);
  first.requests[0].tokens = 999;
  first.freePages[0] = -2;
  first.requests.length = 0;
  const second = pool.snapshot();
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].tokens, 3);
  assert.deepEqual(second.requests[0].pages, [0]);
  assert.deepEqual(second.freePages, [1, 2, 3]);
});

test('allocation policy defaults to lowest and rejects unknown values', () => {
  const pool = new PagePool(8, 4);
  assert.equal(pool.allocationPolicy, 'lowest');
  assert.equal(pool.snapshot().allocationPolicy, 'lowest');
  for (const policy of ['', 'LIFO', 'random', 1, null, {}, true]) {
    expectError(() => new PagePool(8, 4, policy), 'INPUT', `policy ${String(policy)}`);
  }
  assert.equal(new PagePool(8, 4, 'stack').snapshot().allocationPolicy, 'stack');
});

test('stack policy hands back the most recently released pages first', () => {
  const pool = new PagePool(1, 4, 'stack');
  assert.deepEqual(pool.append('a', 2).pages, [0, 1]);
  assert.deepEqual(pool.append('b', 1).pages, [2]);
  assert.deepEqual(pool.snapshot().freePages, [3]);

  pool.release('a');
  assert.deepEqual(pool.snapshot().freePages, [0, 1, 3]);

  const reused = pool.append('c', 2);
  assert.deepEqual(reused.pages, [1, 0], 'LIFO reuse order');
  assert.deepEqual(pool.snapshot().freePages, [3]);
  assert.equal(pool.snapshot().allocatedPages, 3);
  assert.equal(pool.snapshot().logicalTokens, 3);
});

test('500 deterministic stack-policy operations match a LIFO oracle', () => {
  const pageSize = 4;
  const pageCount = 16;
  const pool = new PagePool(pageSize, pageCount, 'stack');
  const oracle = new Map();
  let free = Array.from({ length: pageCount }, (_, index) => pageCount - 1 - index);
  let state = 987654321;

  function nextValue() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  }

  for (let operation = 0; operation < 500; operation += 1) {
    const value = nextValue();
    const id = `s${value % 5}`;
    const releasing = value % 3 === 0;
    if (releasing) {
      const entry = oracle.get(id);
      if (entry === undefined) {
        expectError(() => pool.release(id), 'INPUT', `stack unknown release at ${operation}`);
      } else {
        const summary = pool.release(id);
        assert.deepEqual([...summary.releasedPages].sort((a, b) => a - b),
          [...entry.pages].sort((a, b) => a - b), `stack released pages at ${operation}`);
        assert.equal(summary.releasedTokens, entry.tokens);
        free = [...free, ...entry.pages];
        oracle.delete(id);
      }
    } else {
      const count = 1 + (value % 12);
      const previous = oracle.get(id);
      const tokens = (previous?.tokens ?? 0) + count;
      const wanted = Math.ceil(tokens / pageSize) - (previous === undefined ? 0 : previous.pages.length);
      if (wanted > free.length) {
        expectError(() => pool.append(id, count), 'OOM', `stack oom at ${operation}`);
      } else {
        const taken = [];
        for (let index = 0; index < wanted; index += 1) taken.push(free.pop());
        oracle.set(id, {
          tokens,
          pages: previous === undefined ? taken : [...previous.pages, ...taken],
        });
        pool.append(id, count);
      }
    }

    const snapshot = pool.snapshot();
    assert.equal(snapshot.allocationPolicy, 'stack');
    assert.deepEqual(snapshot.freePages, [...free].sort((a, b) => a - b),
      `stack free pages at ${operation}`);
    assert.equal(snapshot.allocatedPages,
      [...oracle.values()].reduce((total, entry) => total + entry.pages.length, 0),
      `stack allocated pages at ${operation}`);
    assert.equal(snapshot.requests.length, oracle.size, `stack request count at ${operation}`);
    for (const request of snapshot.requests) {
      const entry = oracle.get(request.id);
      assert.ok(entry !== undefined, `stack unexpected request ${request.id} at ${operation}`);
      assert.equal(request.tokens, entry.tokens);
      assert.deepEqual(request.pages, entry.pages, `stack pages for ${request.id} at ${operation}`);
    }
  }
});

test('1000 deterministic append/release operations match an independent oracle', () => {
  const pageSize = 8;
  const pageCount = 32;
  const pool = new PagePool(pageSize, pageCount);
  const oracle = new Map();
  let free = Array.from({ length: pageCount }, (_, index) => index);
  let state = 123456789;

  function nextValue() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  }

  function expectedPages(id) {
    const entry = oracle.get(id);
    return entry === undefined ? 0 : Math.ceil(entry.tokens / pageSize);
  }

  function totalAllocatedPages() {
    let total = 0;
    for (const entry of oracle.values()) total += Math.ceil(entry.tokens / pageSize);
    return total;
  }

  for (let operation = 0; operation < 1000; operation += 1) {
    const value = nextValue();
    const id = `r${value % 7}`;
    const releasing = value % 3 === 0;
    if (releasing) {
      const entry = oracle.get(id);
      if (entry === undefined) {
        expectError(() => pool.release(id), 'INPUT', `unknown release at ${operation}`);
      } else {
        const summary = pool.release(id);
        assert.deepEqual([...summary.releasedPages].sort((a, b) => a - b),
          [...entry.pages].sort((a, b) => a - b), `released pages at ${operation}`);
        assert.equal(summary.releasedTokens, entry.tokens);
        free = [...free, ...entry.pages].sort((a, b) => a - b);
        oracle.delete(id);
      }
    } else {
      const count = 1 + (value % 20);
      const previous = oracle.get(id);
      const tokens = (previous?.tokens ?? 0) + count;
      const wanted = Math.ceil(tokens / pageSize) - expectedPages(id);
      if (wanted > free.length) {
        expectError(() => pool.append(id, count), 'OOM', `oom at ${operation}`);
      } else {
        const taken = free.slice(0, wanted);
        free = free.slice(wanted);
        oracle.set(id, {
          tokens,
          pages: previous === undefined ? taken : [...previous.pages, ...taken],
        });
        pool.append(id, count);
      }
    }

    const snapshot = pool.snapshot();
    let logicalTokens = 0;
    for (const entry of oracle.values()) logicalTokens += entry.tokens;
    const allocatedPages = totalAllocatedPages();
    assert.equal(snapshot.logicalTokens, logicalTokens, `logical tokens at ${operation}`);
    assert.equal(snapshot.logicalBytes, logicalTokens * BYTES_PER_TOKEN,
      `logical bytes at ${operation}`);
    assert.equal(snapshot.allocatedPages, allocatedPages, `allocated pages at ${operation}`);
    assert.equal(snapshot.allocatedTokens, allocatedPages * pageSize,
      `allocated tokens at ${operation}`);
    assert.equal(snapshot.allocatedBytes, allocatedPages * pageSize * BYTES_PER_TOKEN,
      `allocated bytes at ${operation}`);
    assert.equal(snapshot.wasteTokens, allocatedPages * pageSize - logicalTokens,
      `waste tokens at ${operation}`);
    assert.equal(snapshot.wasteBytes, snapshot.wasteTokens * BYTES_PER_TOKEN,
      `waste bytes at ${operation}`);
    assert.deepEqual(snapshot.freePages, free, `free pages at ${operation}`);
    assert.equal(snapshot.requests.length, oracle.size, `request count at ${operation}`);
    for (const request of snapshot.requests) {
      const entry = oracle.get(request.id);
      assert.ok(entry !== undefined, `unexpected request ${request.id} at ${operation}`);
      assert.equal(request.tokens, entry.tokens, `tokens for ${request.id} at ${operation}`);
      assert.deepEqual(request.pages, entry.pages, `pages for ${request.id} at ${operation}`);
      assert.equal(request.allocatedTokens, Math.ceil(entry.tokens / pageSize) * pageSize);
      assert.equal(request.logicalBytes, entry.tokens * BYTES_PER_TOKEN);
      assert.equal(request.allocatedBytes, Math.ceil(entry.tokens / pageSize) * pageSize * BYTES_PER_TOKEN);
    }
  }

  assert.equal(sum([...oracle.values()].map((entry) => entry.tokens)),
    pool.snapshot().logicalTokens);
});
