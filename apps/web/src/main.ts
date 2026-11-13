import { runExperiment } from '../../../packages/core/index.js';
import type { ExperimentResult } from '../../../packages/core/index.js';
import { LabError, MODEL_SPEC, validateInput } from '../../../packages/contracts/index.js';
import type { ExperimentInput, FaultMode } from '../../../packages/contracts/index.js';
import { PagePool } from '../../../packages/simulator/index.js';
import { COPY } from './i18n.js';
import type { Lang } from './i18n.js';
import {
  buildCacheSlots,
  buildCapture,
  buildStepRows,
  summarizeRun,
  parseTokens,
  pagingView,
  formatBytes,
  formatNumber,
  formatError,
  buildExperimentDocument,
  parseExperimentDocument,
  assertPagingOperationBudget,
  MAX_DOCUMENT_BYTES,
} from './view-model.js';
import type {
  CaptureColumn,
  CaptureMark,
  ExperimentDocument,
  PagingOperation,
  StepRow,
} from './view-model.js';
import { replayPaging } from './paging-run.js';

export interface LabSurface {
  ready: boolean;
  runCount: number;
  lastRunMs: number;
  lastInput: ExperimentInput | null;
  lastResult: ExperimentResult | null;
}

declare global {
  interface Window {
    __lab?: LabSurface;
  }
}

interface PagingState {
  pageSize: number;
  pageCount: number;
  pool: PagePool;
  operations: PagingOperation[];
}

interface State {
  lang: Lang;
  input: ExperimentInput | null;
  result: ExperimentResult | null;
  selectedPosition: number;
  error: string | null;
  paging: PagingState;
}

const lab: LabSurface = {
  ready: false,
  runCount: 0,
  lastRunMs: 0,
  lastInput: null,
  lastResult: null,
};
window.__lab = lab;

const state: State = {
  lang: 'en',
  input: null,
  result: null,
  selectedPosition: 0,
  error: null,
  paging: {
    pageSize: 16,
    pageCount: 4,
    pool: new PagePool(16, 4),
    operations: [],
  },
};

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing element #${id}`);
  }
  return element as T;
}

const tokensInput = required<HTMLInputElement>('tokens-input');
const seedInput = required<HTMLInputElement>('seed-input');
const runButton = required<HTMLButtonElement>('run-button');
const runStatus = required<HTMLParagraphElement>('run-status');
const statusLamp = required<HTMLSpanElement>('status-lamp');
const statusWord = required<HTMLSpanElement>('status-word');
const faultTeaching = required<HTMLParagraphElement>('fault-teaching');
const captureBar = required<HTMLDivElement>('capture');
const summary = required<HTMLElement>('summary');
const stepTableBody = required<HTMLTableSectionElement>('step-table').querySelector('tbody');
const stepDetail = required<HTMLDivElement>('step-detail');
const pageSizeInput = required<HTMLInputElement>('page-size');
const pageCountInput = required<HTMLInputElement>('page-count');
const requestIdInput = required<HTMLInputElement>('request-id');
const appendTokensInput = required<HTMLInputElement>('append-tokens');
const appendButton = required<HTMLButtonElement>('append-button');
const releaseButton = required<HTMLButtonElement>('release-button');
const pagingStatus = required<HTMLParagraphElement>('paging-status');
const pageMap = required<HTMLDivElement>('page-map');
const pagingSummary = required<HTMLElement>('paging-summary');
const langButton = required<HTMLButtonElement>('lang-button');
const exportButton = required<HTMLButtonElement>('export-button');
const exportOutput = required<HTMLTextAreaElement>('export-output');
const importInput = required<HTMLTextAreaElement>('import-input');
const importButton = required<HTMLButtonElement>('import-button');
const importStatus = required<HTMLParagraphElement>('import-status');
const bootStatus = document.getElementById('boot-status');

if (stepTableBody === null) {
  throw new Error('missing #step-table tbody');
}

const FAULT_COPY = {
  none: 'faultNone',
  'position-offset': 'faultPositionOffset',
  'cache-overwrite': 'faultCacheOverwrite',
  'mask-current-only': 'faultMaskCurrentOnly',
} as const;

function checkedFault(): FaultMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="fault"]:checked');
  if (checked === null) {
    throw new LabError('INPUT', 'a fault mode must be selected');
  }
  return checked.value as FaultMode;
}

function setText(selector: string, value: string): void {
  const element = summary.querySelector<HTMLElement>(selector);
  if (element !== null) {
    element.textContent = value;
  }
}

function setLamp(next: 'idle' | 'running' | 'pass' | 'fail'): void {
  statusLamp.dataset.state = next;
  statusWord.textContent = next.toUpperCase();
}

function renderFaultTeaching(): void {
  const fault = checkedFault();
  const copy = COPY[state.lang];
  faultTeaching.textContent = `${copy.faultLabel}: ${copy[FAULT_COPY[fault]]}`;
}

function readInput(): ExperimentInput {
  const tokens = parseTokens(tokensInput.value);
  const seedText = seedInput.value.trim();
  if (!/^\d+$/.test(seedText)) {
    throw new LabError('INPUT', 'seed must be a non-negative integer');
  }
  return validateInput({
    schemaVersion: 1,
    seed: Number(seedText),
    tokens,
    fault: checkedFault(),
  });
}

function renderSummary(result: ExperimentResult, runMs: number): void {
  const summaryValues = summarizeRun(result);
  const copy = COPY[state.lang];
  setText('[data-field="passes"]', summaryValues.passes ? copy.pass : copy.diverged);
  setText(
    '[data-field="first-divergence"]',
    summaryValues.firstDivergence === null ? '—' : String(summaryValues.firstDivergence),
  );
  setText('[data-field="max-abs"]', formatNumber(summaryValues.maxAbsoluteError));
  setText('[data-field="max-rel"]', formatNumber(summaryValues.maxRelativeError));
  setText('[data-field="fingerprint"]', summaryValues.fingerprintShort);
  setText('[data-field="engine"]', summaryValues.engineVersion);
  setText('[data-field="compute"]', `${formatNumber(runMs)} ms`);
}

function buildMark(kind: 'write' | 'read' | 'overwrite', layer: number, detail: string): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = `mark mark-${kind}`;
  mark.setAttribute('aria-hidden', 'true');
  mark.title = `Layer ${layer} ${detail}`;
  return mark;
}

function describeLane(marks: CaptureMark[], layer: number): string {
  const own = marks.filter((mark) => mark.layer === layer);
  const writes = own.filter((mark) => mark.kind === 'write').length;
  const reads = own.filter((mark) => mark.kind === 'read').length;
  const overwrites = own.filter((mark) => mark.kind === 'overwrite').length;
  const parts: string[] = [];
  if (writes > 0) {
    parts.push(`${writes} write${writes === 1 ? '' : 's'}`);
  }
  if (reads > 0) {
    parts.push(`${reads} read${reads === 1 ? '' : 's'}`);
  }
  if (overwrites > 0) {
    parts.push(`${overwrites} overwrite${overwrites === 1 ? '' : 's'}`);
  }
  return `layer ${layer}: ${parts.length === 0 ? 'no events' : parts.join(', ')}`;
}

function renderCapture(columns: CaptureColumn[]): void {
  captureBar.replaceChildren();
  for (const column of columns) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-col';
    button.dataset.position = String(column.position);
    const laneText = Array.from(
      { length: MODEL_SPEC.numLayers },
      (_, layer) => describeLane(column.marks, layer),
    ).join('; ');
    button.setAttribute(
      'aria-label',
      `Position ${column.position}, token ${column.token}; ${laneText}`,
    );

    const position = document.createElement('span');
    position.className = 'capture-pos';
    position.textContent = `P${column.position}`;

    const token = document.createElement('span');
    token.className = 'capture-token';
    token.textContent = String(column.token);

    const lanes = document.createElement('span');
    lanes.className = 'lanes';
    for (let layer = 0; layer < MODEL_SPEC.numLayers; layer += 1) {
      const lane = document.createElement('span');
      lane.className = 'lane';
      lane.dataset.layer = String(layer);
      let reads = 0;
      for (const event of column.marks) {
        if (event.layer !== layer) {
          continue;
        }
        if (event.kind === 'write') {
          lane.append(buildMark('write', layer, `write slot ${event.slot}`));
        } else if (event.kind === 'overwrite') {
          lane.append(buildMark('overwrite', layer, `overwrote slot ${event.slot}`));
        } else {
          reads += 1;
        }
      }
      if (reads > 0) {
        lane.append(buildMark('read', layer, `${reads} read${reads === 1 ? '' : 's'}`));
        const count = document.createElement('span');
        count.className = 'mark-count';
        count.textContent = `R${reads}`;
        lane.append(count);
      }
      lanes.append(lane);
    }

    button.append(position, token, lanes);
    if (column.diverged) {
      button.classList.add('is-diverged');
      const flag = document.createElement('span');
      flag.className = 'capture-flag';
      flag.textContent = `▲ DIVERGED at ${column.position}`;
      button.append(flag);
    }
    button.addEventListener('click', () => selectPosition(column.position));
    captureBar.append(button);
  }
  applySelection();
}

function renderStepRows(rows: StepRow[]): void {
  if (stepTableBody === null) {
    return;
  }
  stepTableBody.replaceChildren();
  const copy = COPY[state.lang];
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.position = String(row.position);
    if (!row.passes) {
      tr.classList.add('is-diverged');
    }

    const positionCell = document.createElement('td');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'step-select';
    select.dataset.position = String(row.position);
    select.setAttribute('aria-label', `Select position ${row.position}`);
    select.textContent = `P${row.position}`;
    select.addEventListener('click', () => selectPosition(row.position));
    positionCell.append(select);

    const tokenCell = document.createElement('td');
    tokenCell.textContent = String(row.token);

    const resultCell = document.createElement('td');
    resultCell.textContent = row.passes ? copy.pass : copy.diverged;

    const absCell = document.createElement('td');
    absCell.className = 'num';
    absCell.textContent = formatNumber(row.maxAbs);

    const relCell = document.createElement('td');
    relCell.className = 'num';
    relCell.textContent = formatNumber(row.maxRel);

    tr.append(positionCell, tokenCell, resultCell, absCell, relCell);
    stepTableBody.append(tr);
  }
}

function applySelection(): void {
  for (const column of captureBar.querySelectorAll<HTMLButtonElement>('.capture-col')) {
    const selected = Number(column.dataset.position) === state.selectedPosition;
    column.classList.toggle('is-selected', selected);
    if (selected) {
      column.setAttribute('aria-current', 'step');
    } else {
      column.removeAttribute('aria-current');
    }
  }
  if (stepTableBody !== null) {
    for (const row of stepTableBody.querySelectorAll<HTMLTableRowElement>('tr[data-position]')) {
      row.classList.toggle('is-selected', Number(row.dataset.position) === state.selectedPosition);
    }
  }
}

function selectPosition(position: number): void {
  state.selectedPosition = position;
  applySelection();
  renderDetail();
}

function setPagingText(selector: string, value: string): void {
  const element = pagingSummary.querySelector<HTMLElement>(selector);
  if (element !== null) {
    element.textContent = value;
  }
}

function renderPaging(): void {
  const view = pagingView(state.paging.pool.snapshot());
  pageMap.replaceChildren();
  for (const cell of view.cells) {
    const element = document.createElement('div');
    element.className = 'page-cell';
    element.dataset.page = String(cell.page);
    element.dataset.owner = cell.owner ?? '';
    element.setAttribute(
      'aria-label',
      `Page ${cell.page}: ${cell.owner === null ? 'free' : `owned by ${cell.owner}`}`,
    );
    const number = document.createElement('span');
    number.className = 'page-number';
    number.textContent = String(cell.page);
    const owner = document.createElement('span');
    owner.className = 'page-owner';
    owner.textContent = cell.owner ?? 'free';
    element.append(number, owner);
    pageMap.append(element);
  }
  setPagingText('[data-field="used-pages"]', String(view.usedPages));
  setPagingText('[data-field="free-pages"]', String(view.freePages));
  setPagingText('[data-field="logical-bytes"]', formatBytes(view.logicalBytes));
  setPagingText('[data-field="allocated-bytes"]', formatBytes(view.allocatedBytes));
  setPagingText('[data-field="waste-bytes"]', formatBytes(view.wasteBytes));
  setPagingText('[data-field="capacity-bytes"]', formatBytes(view.capacityBytes));
}

function readPageSetting(input: HTMLInputElement, label: string): number {
  const text = input.value.trim();
  if (!/^\d+$/.test(text)) {
    throw new LabError('INPUT', `${label} must be a positive integer`);
  }
  const value = Number(text);
  if (value < 1 || value > 64) {
    throw new LabError('INPUT', `${label} must be in [1, 64]`);
  }
  return value;
}

function resetPaging(): void {
  try {
    const pageSize = readPageSetting(pageSizeInput, 'page size');
    const pageCount = readPageSetting(pageCountInput, 'page count');
    state.paging = {
      pageSize,
      pageCount,
      pool: new PagePool(pageSize, pageCount),
      operations: [],
    };
    pagingStatus.textContent = `Paging reset: page size ${pageSize}, page count ${pageCount}. Operation log cleared.`;
    renderPaging();
  } catch (error) {
    pagingStatus.textContent = formatError(error);
  }
}

function appendRequest(): void {
  const id = requestIdInput.value;
  const tokensText = appendTokensInput.value.trim();
  try {
    assertPagingOperationBudget(state.paging.operations.length);
    if (!/^\d+$/.test(tokensText)) {
      throw new LabError('INPUT', 'append count must be a positive integer');
    }
    const tokens = Number(tokensText);
    const assignment = state.paging.pool.append(id, tokens);
    state.paging.operations.push({ op: 'append', id, tokens });
    pagingStatus.textContent = `Appended ${tokens} tokens to request "${id}" (${formatBytes(assignment.logicalBytes)} logical).`;
    renderPaging();
  } catch (error) {
    pagingStatus.textContent = formatError(error);
  }
}

function releaseRequest(): void {
  const id = requestIdInput.value;
  try {
    assertPagingOperationBudget(state.paging.operations.length);
    const summary = state.paging.pool.release(id);
    state.paging.operations.push({ op: 'release', id });
    pagingStatus.textContent = `Released request "${id}" (${summary.releasedPages.length} page(s)).`;
    renderPaging();
  } catch (error) {
    pagingStatus.textContent = formatError(error);
  }
}

function renderDetail(): void {
  stepDetail.replaceChildren();
  const result = state.result;
  if (result === null) {
    stepDetail.textContent = 'Run a scenario to inspect a position.';
    return;
  }
  const step = result.steps.find((candidate) => candidate.position === state.selectedPosition);
  if (step === undefined) {
    stepDetail.textContent = `Position ${state.selectedPosition} is outside this run.`;
    return;
  }
  const copy = COPY[state.lang];
  const status = (passes: boolean): string => (passes ? copy.pass : copy.diverged);

  const heading = document.createElement('p');
  heading.className = 'detail-heading';
  heading.textContent = `Position ${step.position} · token ${step.token}`;

  const logits = document.createElement('p');
  logits.textContent = `logits (full vs cached): ${status(step.logits.passes)} · max |Δ| ${formatNumber(step.logits.maxAbsoluteError)} · max rel ${formatNumber(step.logits.maxRelativeError)}`;

  const hiddenHeading = document.createElement('p');
  hiddenHeading.textContent = 'Hidden state:';
  const hiddenList = document.createElement('ul');
  for (const layer of step.hidden) {
    const item = document.createElement('li');
    item.textContent = `Layer ${layer.layer}: ${status(layer.comparison.passes)} · max |Δ| ${formatNumber(layer.comparison.maxAbsoluteError)} · max rel ${formatNumber(layer.comparison.maxRelativeError)}`;
    hiddenList.append(item);
  }

  const eventsHeading = document.createElement('p');
  eventsHeading.textContent = 'Cache events:';
  const eventList = document.createElement('ul');
  if (step.cacheEvents.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'none observed';
    eventList.append(item);
  }
  for (const event of step.cacheEvents) {
    const item = document.createElement('li');
    const reads = event.readSlots.length === 0 ? '—' : event.readSlots.join(', ');
    const overwritten = event.overwrittenSlot === null ? '—' : String(event.overwrittenSlot);
    item.textContent = `Layer ${event.layer}: wrote slot ${event.writeSlot}; read slots [${reads}]; overwritten slot ${overwritten}`;
    eventList.append(item);
  }

  stepDetail.append(heading, logits, hiddenHeading, hiddenList, eventsHeading, eventList);
}

function renderCache(result: ExperimentResult): void {
  const cacheGrid = required<HTMLDivElement>('cache');
  cacheGrid.replaceChildren();
  const copy = COPY[state.lang];
  for (const slots of buildCacheSlots(result)) {
    const layer = slots[0]?.layer ?? 0;
    const section = document.createElement('section');
    section.className = 'cache-layer';

    const heading = document.createElement('h3');
    heading.textContent = `${copy.layerLabel} ${layer}`;

    const grid = document.createElement('div');
    grid.className = 'cache-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', `Layer ${layer} cache slots`);

    for (const slot of slots) {
      const cell = document.createElement('div');
      cell.className = 'slot';
      cell.dataset.layer = String(slot.layer);
      cell.dataset.slot = String(slot.slot);
      cell.classList.toggle('is-written', slot.written);
      cell.classList.toggle('is-read', slot.readCount > 0);
      cell.classList.toggle('is-overwritten', slot.overwritten);
      const writtenText = slot.written ? 'written' : 'not written';
      cell.setAttribute(
        'aria-label',
        `Layer ${slot.layer}, slot ${slot.slot}: ${writtenText}, read ${slot.readCount} times`,
      );

      const number = document.createElement('span');
      number.className = 'slot-number';
      number.textContent = String(slot.slot);

      const badge = document.createElement('span');
      badge.className = 'slot-badge';
      badge.textContent = `${copy.readCount} ${slot.readCount}`;

      cell.append(number, badge);
      if (slot.overwritten) {
        const overwritten = document.createElement('span');
        overwritten.className = 'slot-badge slot-flag';
        overwritten.textContent = copy.overwritten;
        cell.append(overwritten);
      }
      grid.append(cell);
    }

    section.append(heading, grid);
    cacheGrid.append(section);
  }
}

function renderResult(result: ExperimentResult, runMs: number): void {
  renderSummary(result, runMs);
  renderCapture(buildCapture(result));
  renderStepRows(buildStepRows(result));
  renderCache(result);
  renderDetail();
}

function renderRunStatus(): void {
  if (state.error !== null) {
    runStatus.textContent = state.error;
    return;
  }
  const result = state.result;
  if (result === null) {
    runStatus.textContent = '';
    return;
  }
  const copy = COPY[state.lang];
  if (result.comparison.passes) {
    runStatus.textContent = `${copy.pass} · ${result.comparison.stepsCompared}`;
  } else {
    runStatus.textContent = `${copy.diverged} · ${copy.firstDivergence}: ${result.comparison.firstDivergence}`;
  }
}

function commitResult(input: ExperimentInput, result: ExperimentResult, elapsed: number): void {
  lab.lastRunMs = elapsed;
  lab.lastInput = input;
  lab.lastResult = result;
  lab.runCount += 1;
  state.input = input;
  state.result = result;
  state.error = null;
  state.selectedPosition = result.comparison.firstDivergence ?? 0;
  renderResult(result, elapsed);
  setLamp(result.comparison.passes ? 'pass' : 'fail');
  renderRunStatus();
}

function applyLanguage(): void {
  const copy = COPY[state.lang];
  document.documentElement.lang = state.lang;
  for (const element of document.querySelectorAll<HTMLElement>('[data-copy]')) {
    const key = element.dataset.copy;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(copy, key)) {
      element.textContent = copy[key as keyof typeof copy];
    }
  }
  renderFaultTeaching();
  if (state.result !== null) {
    renderResult(state.result, lab.lastRunMs);
  }
  renderRunStatus();
}

function exportExperiment(): void {
  if (state.input === null) {
    exportOutput.value = '';
    return;
  }
  const documentValue = buildExperimentDocument(state.input, {
    pageSize: state.paging.pageSize,
    pageCount: state.paging.pageCount,
    operations: state.paging.operations,
  });
  const payload = JSON.stringify(documentValue, null, 2);
  exportOutput.value = payload;
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'llm-systems-lab-experiment.json';
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setCheckedFault(fault: FaultMode): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="fault"]')) {
    radio.checked = radio.value === fault;
  }
}

function commitImportedPaging(documentValue: ExperimentDocument, pool: PagePool): void {
  const operations = documentValue.paging.operations;
  state.paging = {
    pageSize: documentValue.paging.pageSize,
    pageCount: documentValue.paging.pageCount,
    pool,
    operations: operations.map((operation) => ({ ...operation })),
  };
  pageSizeInput.value = String(documentValue.paging.pageSize);
  pageCountInput.value = String(documentValue.paging.pageCount);
  const last = operations[operations.length - 1];
  if (last !== undefined) {
    requestIdInput.value = last.id;
  }
  const lastAppend = [...operations].reverse().find((operation) => operation.op === 'append');
  if (lastAppend !== undefined && lastAppend.op === 'append') {
    appendTokensInput.value = String(lastAppend.tokens);
  }
  renderPaging();
}

async function importExperiment(): Promise<void> {
  let documentValue: ExperimentDocument;
  let pool: PagePool;
  try {
    if (importInput.value.length > MAX_DOCUMENT_BYTES) {
      throw new LabError(
        'INPUT',
        `experiment document must be at most ${MAX_DOCUMENT_BYTES} characters`,
      );
    }
    documentValue = parseExperimentDocument(importInput.value, MAX_DOCUMENT_BYTES);
    pool = replayPaging(
      documentValue.paging.pageSize,
      documentValue.paging.pageCount,
      documentValue.paging.operations,
    );
  } catch (error) {
    importStatus.textContent = formatError(error);
    return;
  }

  setLamp('running');
  runStatus.textContent = COPY[state.lang].running;
  const started = performance.now();
  try {
    const result = await runExperiment(documentValue.input);
    const elapsed = performance.now() - started;
    tokensInput.value = documentValue.input.tokens.join(', ');
    seedInput.value = String(documentValue.input.seed);
    setCheckedFault(documentValue.input.fault);
    commitImportedPaging(documentValue, pool);
    renderFaultTeaching();
    commitResult(documentValue.input, result, elapsed);
    importStatus.textContent = `Imported ${documentValue.input.tokens.length} token(s) and ${documentValue.paging.operations.length} paging operation(s); results recomputed.`;
  } catch (error) {
    state.error = formatError(error);
    runStatus.textContent = state.error;
    setLamp('fail');
  }
}

async function runOnce(): Promise<void> {
  let input: ExperimentInput;
  try {
    input = readInput();
  } catch (error) {
    state.error = formatError(error);
    runStatus.textContent = state.error;
    setLamp('fail');
    return;
  }

  setLamp('running');
  runStatus.textContent = COPY[state.lang].running;
  const started = performance.now();
  try {
    const result = await runExperiment(input);
    const elapsed = performance.now() - started;
    commitResult(input, result, elapsed);
  } catch (error) {
    state.error = formatError(error);
    runStatus.textContent = state.error;
    setLamp('fail');
  }
}

runButton.addEventListener('click', () => {
  void runOnce();
});

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="fault"]')) {
  radio.addEventListener('change', () => {
    renderFaultTeaching();
  });
}

appendButton.addEventListener('click', appendRequest);
releaseButton.addEventListener('click', releaseRequest);
pageSizeInput.addEventListener('change', resetPaging);
pageCountInput.addEventListener('change', resetPaging);
exportButton.addEventListener('click', exportExperiment);
importButton.addEventListener('click', () => {
  void importExperiment();
});
langButton.addEventListener('click', () => {
  state.lang = state.lang === 'en' ? 'zh' : 'en';
  applyLanguage();
});

async function initialize(): Promise<void> {
  renderFaultTeaching();
  renderPaging();
  if (bootStatus !== null) {
    bootStatus.remove();
  }
  try {
    await runOnce();
  } finally {
    lab.ready = true;
    document.documentElement.dataset.ready = 'true';
  }
}

void initialize();
