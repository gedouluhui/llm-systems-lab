import assert from 'node:assert/strict';
import test from 'node:test';

import { runExperiment } from '../apps/web/dist/packages/core/index.js';
import { PagePool } from '../apps/web/dist/packages/simulator/index.js';
import {
  parseTokens,
  summarizeRun,
  buildCapture,
  buildStepRows,
  buildCacheSlots,
  pagingView,
  buildExperimentDocument,
  parseExperimentDocument,
  replayPaging,
  formatBytes,
  formatNumber,
  shortHash,
  formatError,
  assertPagingOperationBudget,
  MAX_PAGING_OPERATIONS,
} from '../apps/web/dist/apps/web/src/view-model.js';
import { LabError } from '../apps/web/dist/packages/contracts/index.js';

const base = { schemaVersion: 1, seed: 7, tokens: [1, 4, 2, 8, 3, 9], fault: 'none' };

test('summary reports the real comparison, never a hardcoded pass', async () => {
  const normal = await runExperiment(base);
  const summary = summarizeRun(normal);
  assert.equal(summary.passes, true);
  assert.equal(summary.firstDivergence, null);
  assert.equal(summary.stepsCompared, 6);
  assert.equal(summary.fingerprintShort, '75384d2cbebc…');
  assert.ok(Number.isFinite(summary.maxAbsoluteError));
});

test('a fault run exposes divergence at position 1 and overwrite marks', async () => {
  const fault = await runExperiment({ ...base, fault: 'cache-overwrite' });
  const summary = summarizeRun(fault);
  assert.equal(summary.passes, false);
  assert.equal(summary.firstDivergence, 1);
  const capture = buildCapture(fault);
  assert.equal(capture.length, 6);
  assert.equal(capture[0].diverged, false);
  assert.equal(capture[1].diverged, true);
  assert.ok(capture[1].marks.some((mark) => mark.kind === 'overwrite' && mark.slot === 0));
  const slots = buildCacheSlots(fault);
  assert.equal(slots.length, 2);
  assert.ok(slots[0][0].overwritten);
});

test('step rows mirror every per-position comparison', async () => {
  const normal = await runExperiment(base);
  const rows = buildStepRows(normal);
  assert.deepEqual(rows.map((row) => row.position), [0, 1, 2, 3, 4, 5]);
  assert.ok(rows.every((row) => row.passes === true));
  assert.ok(rows.every((row) => row.cacheEvents.length === 2));
});

test('paging view maps owners, waste and capacity from the simulator snapshot', () => {
  const pool = new PagePool(16, 4);
  pool.append('a', 32);
  pool.append('a', 1);
  const view = pagingView(pool.snapshot());
  assert.equal(view.cells.length, 4);
  assert.deepEqual(view.cells.map((cell) => cell.owner), ['a', 'a', 'a', null]);
  assert.equal(view.usedPages, 3);
  assert.equal(view.freePages, 1);
  assert.equal(view.logicalBytes, 8448);
  assert.equal(view.allocatedBytes, 12288);
  assert.equal(view.wasteBytes, 3840);
  assert.equal(view.capacityBytes, 16384);
});

test('capture marks keep per-layer read events instead of one aggregate read', async () => {
  const normal = await runExperiment(base);
  const capture = buildCapture(normal);
  const readsAtOne = capture[1].marks.filter((mark) => mark.kind === 'read');
  assert.deepEqual([...new Set(readsAtOne.map((mark) => mark.layer))].sort(), [0, 1]);
  const readsAtTwo = capture[2].marks.filter((mark) => mark.kind === 'read');
  assert.equal(readsAtTwo.filter((mark) => mark.layer === 0).length, 3);
  assert.equal(readsAtTwo.filter((mark) => mark.layer === 1).length, 3);
});

test('the live paging log shares the document ceiling of 1000 operations', () => {
  assert.doesNotThrow(() => assertPagingOperationBudget(0));
  assert.doesNotThrow(() => assertPagingOperationBudget(MAX_PAGING_OPERATIONS - 1));
  assert.throws(() => assertPagingOperationBudget(MAX_PAGING_OPERATIONS), /1000/);
  assert.throws(() => assertPagingOperationBudget(MAX_PAGING_OPERATIONS + 1), /1000/);
  assert.throws(() => assertPagingOperationBudget(-1), /non-negative/);
  assert.throws(() => assertPagingOperationBudget(1.5), /non-negative/);
});

test('parseTokens accepts separators and rejects malformed or out-of-range input', () => {
  assert.deepEqual(parseTokens('1, 4 2\n8'), [1, 4, 2, 8]);
  assert.deepEqual(parseTokens('1 2 3'), [1, 2, 3]);
  assert.deepEqual(parseTokens(' 7 '), [7]);
  for (const bad of ['', '1,,2', '1, ,2', '1.5', '32', '-1', '1;2', ',1', '1,']) {
    assert.throws(() => parseTokens(bad), /token|integer|array|empty/i, bad);
  }
  assert.throws(() => parseTokens(Array.from({ length: 65 }, () => 1).join(',')), /64/);
});

test('document round-trip validates and replays paging', () => {
  const operations = [
    { op: 'append', id: 'a', tokens: 32 },
    { op: 'append', id: 'a', tokens: 1 },
    { op: 'release', id: 'a' },
  ];
  const doc = buildExperimentDocument(base, { pageSize: 16, pageCount: 4, operations });
  const parsed = parseExperimentDocument(JSON.stringify(doc));
  assert.deepEqual(parsed, doc);
  const restored = replayPaging(16, 4, operations);
  assert.equal(restored.snapshot().requests.length, 0);
});

test('document parsing rejects unknown versions, unknown keys, oversize and bad ops', () => {
  const doc = buildExperimentDocument(base, { pageSize: 16, pageCount: 4, operations: [] });
  assert.throws(() => parseExperimentDocument(JSON.stringify({ ...doc, schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => parseExperimentDocument(JSON.stringify({ ...doc, extra: true })), /unexpected/i);
  assert.throws(() => parseExperimentDocument(JSON.stringify({ ...doc, kind: 'other' })), /kind/);
  assert.throws(() => parseExperimentDocument('x'.repeat(262145)), /262144/);
  assert.throws(() => parseExperimentDocument('not json'), /JSON/i);
  assert.throws(() => parseExperimentDocument(JSON.stringify({
    ...doc, paging: { ...doc.paging, operations: [{ op: 'append', id: '../x', tokens: 1 }] },
  })), /request id/i);
  assert.throws(() => parseExperimentDocument(JSON.stringify({
    ...doc, paging: { ...doc.paging, pageSize: 0 },
  })), /pageSize/);
  assert.throws(() => parseExperimentDocument(JSON.stringify({
    ...doc, paging: { ...doc.paging, operations: Array.from({ length: 1001 }, () => ({ op: 'release', id: 'a' })) },
  })), /1000/);
  assert.throws(() => parseExperimentDocument(JSON.stringify({
    ...doc,
    paging: {
      pageSize: 16,
      pageCount: 1,
      operations: [{ op: 'append', id: 'a', tokens: 16 }, { op: 'append', id: 'b', tokens: 1 }],
    },
  })), (error) => error?.code === 'OOM');
  assert.throws(() => replayPaging(16, 1, [{ op: 'append', id: 'a', tokens: 16 }, { op: 'append', id: 'b', tokens: 1 }]), (error) => error?.code === 'OOM');
});

test('formatBytes uses exact bytes below 1 KiB and one decimal above', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1,023 B');
  assert.equal(formatBytes(8192), '8.0 KiB');
  assert.equal(formatBytes(12288), '12.0 KiB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MiB');
});

test('formatNumber keeps tiny values legible', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(0.0000123), '1.230e-5');
  assert.equal(formatNumber(123456), '1.235e+5');
  assert.equal(formatNumber(1.25), '1.25');
});

test('shortHash and formatError are stable and never leak stack traces', () => {
  assert.equal(shortHash('abcdef0123456789'), 'abcdef012345…');
  assert.equal(formatError(new LabError('OOM', 'no pages left')), 'OOM: no pages left');
  assert.equal(formatError(new Error('plain failure')), 'plain failure');
  assert.equal(formatError(42), 'Unexpected error');
});
