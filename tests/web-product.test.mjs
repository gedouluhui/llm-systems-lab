import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { COPY, formatCopy } from '../apps/web/dist/apps/web/src/i18n.js';
import { runExperiment } from '../dist/packages/core/index.js';
import { validateInput } from '../dist/packages/contracts/index.js';

const src = new URL('../apps/web/dist/apps/web/src/', import.meta.url);
const productKeys = ['heading', 'lede', 'tokenHint', 'seedHint', 'controlsLabel', 'instrumentLabel',
  'captureAria', 'tableAria', 'pageMapAria', 'langAria', 'exportAria', 'importAria',
  'positionLabel', 'capacity', 'writeLegend', 'readLegend', 'overwriteLegend',
  'positionAria', 'selectPosition', 'laneDescription', 'markWrite', 'markRead', 'markOverwrite',
  'detailPosition', 'detailLogits', 'detailHidden', 'detailLayer', 'detailEvents', 'detailEvent',
  'emptyEvents', 'pageFree', 'pageOwned', 'free', 'pagingReset', 'pagingAppended', 'pagingReleased',
  'imported', 'runIdentity', 'draftChanged', 'previous', 'next', 'firstMismatch', 'navigationHint',
  'baselineLesson', 'overwriteLesson', 'recomputeLesson', 'baselineGoal', 'overwriteGoal', 'recomputeGoal',
  'themeLabel', 'themeSystem', 'themeLight', 'themeDark', 'numericalTitle', 'computationTitle',
  'technicalTitle', 'cancelButton', 'cancelled', 'idle', 'cacheAria', 'slotAria', 'written', 'notWritten'];

test('all product copy uses production bilingual dictionary including attributes and dynamic messages', () => {
  for (const lang of ['en', 'zh']) for (const key of productKeys) {
    assert.equal(typeof COPY[lang][key], 'string', `${lang}.${key} missing`);
    assert.ok(COPY[lang][key].length > 0);
  }
  for (const key of productKeys) {
    assert.doesNotMatch(COPY.zh[key], /\b(Position|Select position|Imported|Capacity|Layer)\b/, key);
    const names = [...COPY.en[key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual([...COPY.zh[key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), names, key);
    const values = Object.fromEntries(names.map(k => [k, 7]));
    assert.doesNotMatch(formatCopy(COPY.zh[key], values), /\{\w+\}/);
  }
});

test('static shell translates text and accessible attributes using known copy keys', () => {
  const html = readFileSync(new URL('../apps/web/static/index.html', import.meta.url), 'utf8');
  assert.match(html, /<h1[^>]*data-copy="heading"/);
  assert.match(html, /data-copy-aria="captureAria"/);
  assert.match(html, /id="theme-select"/);
  assert.match(html, /id="previous-position"/);
  assert.match(html, /id="first-divergence-button"/);
  for (const match of html.matchAll(/data-copy(?:-aria|-title|-placeholder)?="([^"]+)"/g)) {
    assert.ok(COPY.en[match[1]] && COPY.zh[match[1]], match[1]);
  }
  assert.doesNotMatch(html, /catches every fault|每种故障.*完全看不出来/);
});

test('three lessons validate real inputs and demonstrate separate numerical and work outcomes', async () => {
  const url = new URL('lesson-presets.js', src);
  assert.ok(existsSync(url), 'lesson-presets module missing');
  const { lessonInput, LESSON_IDS } = await import(url.href);
  assert.deepEqual(LESSON_IDS, ['baseline', 'overwrite', 'recompute']);
  for (const [id, fault, passes, tokens] of [
    ['baseline', 'none', true, 6], ['overwrite', 'cache-overwrite', false, 6],
    ['recompute', 'no-cache-recompute', true, 21],
  ]) {
    const input = lessonInput(id);
    assert.deepEqual(validateInput(input), input);
    assert.deepEqual(input, { schemaVersion: 1, seed: 7, tokens: [1,4,2,8,3,9], fault });
    const result = await runExperiment(input);
    assert.equal(result.comparison.passes, passes);
    assert.equal(result.workSummary.totalRecomputeTokens, tokens);
    input.tokens[0] = 31;
    assert.equal(lessonInput(id).tokens[0], 1, 'fresh input per run');
  }
  assert.throws(() => lessonInput('unknown'));
});

test('position boundaries and first divergence navigation never select outside a run', async () => {
  const url = new URL('lesson-presets.js', src);
  assert.ok(existsSync(url), 'lesson-presets module missing');
  const { navigatePosition } = await import(url.href);
  assert.equal(navigatePosition(0, 6, 'previous', null), 0);
  assert.equal(navigatePosition(5, 6, 'next', null), 5);
  assert.equal(navigatePosition(2, 6, 'home', null), 0);
  assert.equal(navigatePosition(2, 6, 'end', null), 5);
  assert.equal(navigatePosition(2, 6, 'divergence', 1), 1);
  assert.equal(navigatePosition(2, 6, 'divergence', null), 2);
  assert.equal(navigatePosition(0, 0, 'end', null), 0);
});

test('theme resolution and blocked preference storage stay independent of experiment data', async () => {
  const url = new URL('presentation.js', src);
  assert.ok(existsSync(url), 'presentation module missing');
  const { resolveTheme, readTheme, saveTheme, localizedError } = await import(url.href);
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(readTheme({ getItem: () => 'invalid' }), 'system');
  assert.equal(readTheme({ getItem() { throw Error('blocked'); } }), 'system');
  assert.doesNotThrow(() => saveTheme({ setItem() { throw Error('blocked'); } }, 'dark'));
  const values = {};
  saveTheme({ setItem: (key, value) => { values[key] = value; } }, 'light');
  assert.deepEqual(values, { 'llm-lab-theme': 'light' });
  assert.match(localizedError({ code: 'OOM' }, 'zh', 'paging'), /OOM.*空闲页不足/);
  assert.match(localizedError({ code: 'INPUT' }, 'zh', 'import'), /有效.*实验文档/);
  assert.doesNotMatch(localizedError({ code: 'WORKER_START' }, 'zh', 'run'), /could not/);
});
