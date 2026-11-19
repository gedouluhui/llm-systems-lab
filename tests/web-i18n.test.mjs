import assert from 'node:assert/strict';
import test from 'node:test';

import { COPY, formatCopy } from '../apps/web/dist/apps/web/src/i18n.js';

const REQUIRED_KEYS = [
  'appTitle', 'tagline', 'modelLabel', 'seedLabel', 'tokensLabel', 'faultLabel',
  'faultNone', 'faultPositionOffset', 'faultCacheOverwrite', 'faultMaskCurrentOnly',
  'faultNoCacheRecompute',
  'runButton', 'running', 'pass', 'diverged', 'statusLabel', 'summaryTitle',
  'detailTitle', 'firstDivergence', 'maxAbs', 'maxRel',
  'workClass', 'workTokens', 'workKvReads', 'workAttention', 'workHint',
  'workOk', 'workDegraded',
  'fingerprint', 'engine', 'captureTitle', 'captureHint', 'stepTitle', 'stepHint',
  'cacheTitle', 'cacheHint', 'layerLabel', 'slotLabel', 'readCount', 'overwritten',
  'pagingTitle', 'pagingHint', 'pageSize', 'pageCount', 'requestId', 'appendTokens',
  'appendButton', 'releaseButton', 'usedPages', 'freePages', 'logicalBytes',
  'allocatedBytes', 'wasteBytes', 'exportTitle', 'exportButton', 'exportHint',
  'importTitle', 'importButton', 'importHint', 'invalidInput', 'invalidDocument',
  'fullForwardTime', 'cachedDecoderTime', 'totalTime',
  'oom', 'computeTime', 'notGpuTime', 'langButton', 'routeBaseline', 'routeCache',
  'routeFault', 'routePaging', 'routeExport', 'explainBaselineEn', 'explainBaselineZh',
  'explainCacheEn', 'explainCacheZh', 'explainFaultEn', 'explainFaultZh',
  'explainPagingEn', 'explainPagingZh', 'skipLink', 'footerNote',
];

test('every UI string exists in both languages and is non-empty', () => {
  assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.zh).sort());
  for (const lang of ['en', 'zh']) {
    for (const [key, value] of Object.entries(COPY[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key}`);
      assert.ok(value.trim().length > 0, `${lang}.${key}`);
    }
  }
});

test('the bilingual route carries every required key', () => {
  for (const lang of ['en', 'zh']) {
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in COPY[lang], `${lang}.${key}`);
    }
    // Legacy keys remain required; product/attribute keys are covered by web-product.
    // Allow additive copy while the key-parity test above rejects translation gaps.
    assert.ok(Object.keys(COPY[lang]).length >= REQUIRED_KEYS.length, lang);
  }
});

test('formatCopy fills named placeholders without touching other text', () => {
  assert.equal(formatCopy('Run seed {seed}', { seed: 7 }), 'Run seed 7');
  assert.equal(formatCopy('{a} / {b}', { a: 'x', b: 2 }), 'x / 2');
  assert.equal(formatCopy('Keep {unknown}', {}), 'Keep {unknown}');
});
