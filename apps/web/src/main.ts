import type { ExperimentResult } from '../../../packages/core/index.js';
import { ExperimentWorkerClient } from './worker-client.js';
import type { WorkerRunResult } from './worker-client.js';
import { LabError, MODEL_SPEC, validateInput } from '../../../packages/contracts/index.js';
import type { ExperimentInput, FaultMode } from '../../../packages/contracts/index.js';
import { PagePool } from '../../../packages/simulator/index.js';
import { COPY, formatCopy } from './i18n.js';
import type { Lang, CopyKey } from './i18n.js';
import { LESSON_IDS, lessonInput, navigatePosition } from './lesson-presets.js';
import type { LessonId, PositionAction } from './lesson-presets.js';
import { localizedError, resolveTheme, readTheme, saveTheme } from './presentation.js';
import type { ThemePreference, ErrorContext } from './presentation.js';
import {
  buildCacheSlots,
  buildCapture,
  buildStepRows,
  summarizeRun,
  parseTokens,
  pagingView,
  formatBytes,
  formatNumber,
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
  fullForwardMs: number;
  cachedDecoderMs: number;
  totalMs: number;
  roundTripMs: number;
  renderMs: number;
  executionContext: 'worker' | null;
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

type Notice = { key: CopyKey; values?: Record<string, string | number> } | { error: unknown; context: ErrorContext };
let pagingNotice: Notice | null = null;
let importNotice: Notice | null = null;
let exportReady = false;
let cancelled = false;
let activeLesson: LessonId | null = null;

function message(key: CopyKey, values: Record<string, string | number> = {}): string {
  return formatCopy(COPY[state.lang][key], values);
}
function noticeText(notice: Notice | null): string {
  return notice === null ? '' : 'key' in notice ? message(notice.key, notice.values)
    : localizedError(notice.error, state.lang, notice.context);
}

interface State {
  lang: Lang;
  input: ExperimentInput | null;
  result: ExperimentResult | null;
  selectedPosition: number;
  error: Notice | null;
  pending: boolean;
  paging: PagingState;
}

const lab: LabSurface = {
  ready: false,
  runCount: 0,
  lastRunMs: 0,
  fullForwardMs: 0,
  cachedDecoderMs: 0,
  totalMs: 0,
  roundTripMs: 0,
  renderMs: 0,
  executionContext: null,
  lastInput: null,
  lastResult: null,
};
window.__lab = lab;
const workerClient = new ExperimentWorkerClient();
let latestIntent = 0;
window.addEventListener('pagehide', () => {
  latestIntent += 1;
  workerClient.cancel();
  if (state.pending) {
    // A BFCache restore must not show work that was already terminated.
    state.pending = false;
    setLamp(state.result === null ? 'idle' : state.result.comparison.passes ? 'pass' : 'fail');
    renderRunStatus();
  }
});

const state: State = {
  lang: 'en',
  input: null,
  result: null,
  selectedPosition: 0,
  error: null,
  pending: false,
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
const workNote = required<HTMLParagraphElement>('work-note');
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
  'no-cache-recompute': 'faultNoCacheRecompute',
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
  statusWord.textContent = message(next === 'pass' ? 'pass' : next === 'fail' ? 'diverged' : next === 'running' ? 'running' : 'idle');
  required<HTMLButtonElement>('cancel-button').disabled = !state.pending;
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
  setText('[data-field="full-forward"]', `${formatNumber(lab.fullForwardMs)} ms`);
  setText('[data-field="cached-decoder"]', `${formatNumber(lab.cachedDecoderMs)} ms`);
  setText('[data-field="total"]', `${formatNumber(lab.totalMs)} ms`);
  setText('[data-field="work-class"]', summaryValues.complexityClass);
  setText(
    '[data-field="work-tokens"]',
    `${formatNumber(summaryValues.totalRecomputeTokens)} / ${formatNumber(summaryValues.expectedCachedTokens)}`,
  );
  setText('[data-field="work-kv"]', formatNumber(summaryValues.totalKvReadSlots));
  setText('[data-field="work-attention"]', formatNumber(summaryValues.totalAttentionMacs));
  workNote.textContent = summaryValues.degraded ? copy.workDegraded : copy.workOk;
  workNote.dataset.state = summaryValues.degraded ? 'degraded' : 'ok';
  required('numerical-verdict').dataset.state = summaryValues.passes ? 'ok' : 'fail';
  required('computation-verdict').dataset.state = summaryValues.degraded ? 'degraded' : 'ok';
  required('numerical-note').textContent = summaryValues.passes ? copy.numericalPass : copy.numericalFail;
  required('work-verdict').textContent = summaryValues.degraded ? copy.recomputeVerdict : copy.cachedVerdict;
  setText('[data-field="render"]', `${formatNumber(lab.renderMs)} ms`);
  renderIdentity();
}

function buildMark(kind: 'write' | 'read' | 'overwrite', layer: number, values: Record<string, number>): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = `mark mark-${kind}`;
  mark.setAttribute('aria-hidden', 'true');
  const key = { write: 'markWrite', read: 'markRead', overwrite: 'markOverwrite' } as const;
  mark.dataset.copyTitle = key[kind];
  mark.dataset.copyValues = JSON.stringify({ layer, ...values });
  mark.title = message(key[kind], { layer, ...values });
  return mark;
}

function describeLane(marks: CaptureMark[], layer: number): string {
  const own = marks.filter((mark) => mark.layer === layer);
  const writes = own.filter((mark) => mark.kind === 'write').length;
  const reads = own.filter((mark) => mark.kind === 'read').length;
  const overwrites = own.filter((mark) => mark.kind === 'overwrite').length;
  return message('laneDescription', { layer, writes, reads, overwrites });
}

function renderCapture(columns: CaptureColumn[], translateOnly = false): void {
  if (!translateOnly) captureBar.replaceChildren();
  for (const column of columns) {
    const button = translateOnly
      ? captureBar.querySelector<HTMLButtonElement>(`[data-position="${column.position}"]`)!
      : document.createElement('button');
    button.type = 'button';
    button.className = 'capture-col';
    button.dataset.position = String(column.position);
    const laneText = Array.from(
      { length: MODEL_SPEC.numLayers },
      (_, layer) => describeLane(column.marks, layer),
    ).join('; ');
    button.setAttribute(
      'aria-label',
      message('positionAria', { position: column.position, token: column.token, lanes: laneText }),
    );
    if (translateOnly) {
      const flag = button.querySelector('.capture-flag');
      if (flag) flag.textContent = message('divergenceFlag', { position: column.position });
      continue;
    }

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
          lane.append(buildMark('write', layer, { slot: event.slot }));
        } else if (event.kind === 'overwrite') {
          lane.append(buildMark('overwrite', layer, { slot: event.slot }));
        } else {
          reads += 1;
        }
      }
      if (reads > 0) {
        lane.append(buildMark('read', layer, { reads }));
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
      flag.textContent = message('divergenceFlag', { position: column.position });
      button.append(flag);
    }
    button.addEventListener('click', () => selectPosition(column.position));
    captureBar.append(button);
  }
  applySelection();
}

function renderStepRows(rows: StepRow[], translateOnly = false): void {
  if (stepTableBody === null) return;
  if (!translateOnly) stepTableBody.replaceChildren();
  const copy = COPY[state.lang];
  for (const row of rows) {
    if (translateOnly) {
      const tr = stepTableBody.querySelector<HTMLTableRowElement>(`tr[data-position="${row.position}"]`)!;
      tr.querySelector('button')!.setAttribute('aria-label', message('selectPosition', { position: row.position }));
      tr.cells[2]!.textContent = row.passes ? copy.pass : copy.diverged;
      continue;
    }
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
    select.setAttribute('aria-label', message('selectPosition', { position: row.position }));
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
  const length = state.result?.steps.length ?? 0;
  state.selectedPosition = Math.max(0, Math.min(Math.max(0, length - 1), position));
  applySelection();
  renderDetail();
  renderNavigation();
  const column = captureBar.querySelector<HTMLElement>(`[data-position="${state.selectedPosition}"]`);
  if (column) {
    const rect = column.getBoundingClientRect();
    const container = captureBar.getBoundingClientRect();
    // Only scroll this strip. scrollIntoView would also jump the whole document.
    if (rect.left < container.left) captureBar.scrollLeft += rect.left - container.left - 4;
    if (rect.right > container.right) captureBar.scrollLeft += rect.right - container.right + 4;
  }
}

function renderNavigation(): void {
  const length = state.result?.steps.length ?? 0;
  required<HTMLButtonElement>('previous-position').disabled = length === 0 || state.selectedPosition === 0;
  required<HTMLButtonElement>('next-position').disabled = length === 0 || state.selectedPosition >= length - 1;
  required<HTMLButtonElement>('first-divergence-button').disabled = state.result?.comparison.firstDivergence == null;
  required('position-progress').textContent = length === 0 ? '' : message('positionProgress', {
    position: state.selectedPosition, last: length - 1, token: state.input!.tokens[state.selectedPosition]!,
  });
}
function navigate(action: PositionAction, focus = false): void {
  selectPosition(navigatePosition(state.selectedPosition, state.result?.steps.length ?? 0,
    action, state.result?.comparison.firstDivergence ?? null));
  if (focus) captureBar.querySelector<HTMLButtonElement>('[aria-current]')?.focus({ preventScroll: true });
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
      cell.owner === null ? message('pageFree', { page: cell.page }) : message('pageOwned', { page: cell.page, owner: cell.owner }),
    );
    const number = document.createElement('span');
    number.className = 'page-number';
    number.textContent = String(cell.page);
    const owner = document.createElement('span');
    owner.className = 'page-owner';
    owner.textContent = cell.owner ?? COPY[state.lang].free;
    element.append(number, owner);
    pageMap.append(element);
  }
  setPagingText('[data-field="used-pages"]', String(view.usedPages));
  setPagingText('[data-field="free-pages"]', String(view.freePages));
  setPagingText('[data-field="logical-bytes"]', formatBytes(view.logicalBytes));
  setPagingText('[data-field="allocated-bytes"]', formatBytes(view.allocatedBytes));
  setPagingText('[data-field="waste-bytes"]', formatBytes(view.wasteBytes));
  setPagingText('[data-field="capacity-bytes"]', formatBytes(view.capacityBytes));
  pagingStatus.textContent = noticeText(pagingNotice);
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
    pagingNotice = { key: 'pagingReset', values: { size: pageSize, count: pageCount } };
    renderPaging();
  } catch (error) {
    pagingNotice = { error, context: 'paging' };
    pagingStatus.textContent = noticeText(pagingNotice);
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
    pagingNotice = { key: 'pagingAppended', values: { tokens, id, bytes: formatBytes(assignment.logicalBytes) } };
    renderPaging();
  } catch (error) {
    pagingNotice = { error, context: 'paging' };
    pagingStatus.textContent = noticeText(pagingNotice);
  }
}

function releaseRequest(): void {
  const id = requestIdInput.value;
  try {
    assertPagingOperationBudget(state.paging.operations.length);
    const summary = state.paging.pool.release(id);
    state.paging.operations.push({ op: 'release', id });
    pagingNotice = { key: 'pagingReleased', values: { id, pages: summary.releasedPages.length } };
    renderPaging();
  } catch (error) {
    pagingNotice = { error, context: 'paging' };
    pagingStatus.textContent = noticeText(pagingNotice);
  }
}

function renderDetail(): void {
  stepDetail.replaceChildren();
  const result = state.result;
  if (result === null) {
    stepDetail.textContent = message('emptyDetail');
    return;
  }
  const step = result.steps.find((candidate) => candidate.position === state.selectedPosition);
  if (step === undefined) {
    stepDetail.textContent = message('outsideDetail', { position: state.selectedPosition });
    return;
  }
  const copy = COPY[state.lang];
  const status = (passes: boolean): string => (passes ? copy.pass : copy.diverged);

  const heading = document.createElement('p');
  heading.className = 'detail-heading';
  heading.textContent = message('detailPosition', { position: step.position, token: step.token });

  const logits = document.createElement('p');
  logits.textContent = message('detailLogits', { status: status(step.logits.passes), abs: formatNumber(step.logits.maxAbsoluteError), rel: formatNumber(step.logits.maxRelativeError) });

  const hiddenHeading = document.createElement('p');
  hiddenHeading.textContent = copy.detailHidden;
  const hiddenList = document.createElement('ul');
  for (const layer of step.hidden) {
    const item = document.createElement('li');
    item.textContent = message('detailLayer', { layer: layer.layer, status: status(layer.comparison.passes), abs: formatNumber(layer.comparison.maxAbsoluteError), rel: formatNumber(layer.comparison.maxRelativeError) });
    hiddenList.append(item);
  }

  const eventsHeading = document.createElement('p');
  eventsHeading.textContent = copy.detailEvents;
  const eventList = document.createElement('ul');
  if (step.cacheEvents.length === 0) {
    const item = document.createElement('li');
    item.textContent = copy.emptyEvents;
    eventList.append(item);
  }
  for (const event of step.cacheEvents) {
    const item = document.createElement('li');
    const reads = event.readSlots.length === 0 ? '—' : event.readSlots.join(', ');
    const overwritten = event.overwrittenSlot === null ? '—' : String(event.overwrittenSlot);
    item.textContent = message('detailEvent', { layer: event.layer, write: event.writeSlot, reads, overwritten });
    eventList.append(item);
  }

  const hiddenBlock = document.createElement('div');
  hiddenBlock.append(hiddenHeading, hiddenList);
  const eventBlock = document.createElement('div');
  eventBlock.append(eventsHeading, eventList);
  const work = document.createElement('p');
  work.className = 'detail-work';
  work.textContent = message('detailWork', { tokens: step.work.recomputeTokens, reads: step.work.kvReadSlots, macs: step.work.attentionMacs });
  stepDetail.append(heading, logits, hiddenBlock, eventBlock, work);
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
    grid.setAttribute('aria-label', message('cacheAria', { layer }));

    for (const slot of slots) {
      const cell = document.createElement('div');
      cell.className = 'slot';
      cell.dataset.layer = String(slot.layer);
      cell.dataset.slot = String(slot.slot);
      cell.classList.toggle('is-written', slot.written);
      cell.classList.toggle('is-read', slot.readCount > 0);
      cell.classList.toggle('is-overwritten', slot.overwritten);
      const writtenText = slot.written ? copy.written : copy.notWritten;
      cell.setAttribute(
        'aria-label',
        message('slotAria', { layer: slot.layer, slot: slot.slot, written: writtenText, reads: slot.readCount }),
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
  required<HTMLButtonElement>('cancel-button').disabled = !state.pending;
  if (cancelled) {
    runStatus.textContent = message('cancelled');
    return;
  }
  if (state.pending) {
    runStatus.textContent = COPY[state.lang].running;
    return;
  }
  if (state.error !== null) {
    runStatus.textContent = noticeText(state.error);
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

function commitResult(input: ExperimentInput, envelope: WorkerRunResult): void {
  const { result, timing, roundTripMs } = envelope;
  state.pending = false;
  lab.lastRunMs = roundTripMs;
  lab.roundTripMs = roundTripMs;
  lab.fullForwardMs = timing.fullForwardMs;
  lab.cachedDecoderMs = timing.cachedDecoderMs;
  lab.totalMs = timing.totalMs;
  lab.executionContext = envelope.executionContext;
  lab.lastInput = input;
  lab.lastResult = result;
  lab.runCount += 1;
  state.input = input;
  state.result = result;
  state.error = null;
  state.selectedPosition = result.comparison.firstDivergence ?? 0;
  const renderStarted = performance.now();
  renderResult(result, roundTripMs);
  renderNavigation();
  lab.renderMs = performance.now() - renderStarted;
  setText('[data-field="render"]', `${formatNumber(lab.renderMs)} ms`);
  setLamp(result.comparison.passes ? 'pass' : 'fail');
  renderRunStatus();
}

function applyLanguage(): void {
  const copy = COPY[state.lang];
  document.documentElement.lang = state.lang;
  document.title = copy.appTitle;
  for (const [data, attribute] of [['data-copy', null], ['data-copy-aria', 'aria-label'],
    ['data-copy-title', 'title'], ['data-copy-placeholder', 'placeholder']] as const) {
    for (const element of document.querySelectorAll<HTMLElement>(`[${data}]`)) {
      const key = element.getAttribute(data) as CopyKey;
      if (!Object.prototype.hasOwnProperty.call(copy, key)) continue;
      const values = element.dataset.copyValues ? JSON.parse(element.dataset.copyValues) as Record<string, number> : {};
      const text = message(key, values);
      if (attribute === null) element.textContent = text;
      else element.setAttribute(attribute, text);
    }
  }
  required('explain-en').hidden = state.lang !== 'en';
  required('explain-zh').hidden = state.lang !== 'zh';
  renderFaultTeaching();
  renderLesson();
  if (state.result !== null) {
    // Translation updates existing interactive nodes: no focus loss or rerun.
    renderSummary(state.result, lab.lastRunMs);
    renderCapture(buildCapture(state.result), true);
    renderStepRows(buildStepRows(state.result), true);
    renderCache(state.result);
    renderDetail();
  }
  renderNavigation();
  renderPaging();
  importStatus.textContent = noticeText(importNotice);
  required('export-status').textContent = exportReady ? copy.exported : '';
  setLamp((statusLamp.dataset.state ?? 'idle') as 'idle' | 'running' | 'pass' | 'fail');
  renderRunStatus();
}

function renderIdentity(): void {
  const input = state.input;
  if (!input) return;
  required('run-identity').textContent = message('runIdentity', { run: lab.runCount,
    seed: input.seed, count: input.tokens.length, fault: message(FAULT_COPY[input.fault]) });
  required('run-tokens').textContent = message('runTokens', { tokens: input.tokens.join(', ') });
  let changed = true;
  try { changed = JSON.stringify(readInput()) !== JSON.stringify(input); } catch { /* Invalid draft differs too. */ }
  required('draft-status').textContent = changed ? message('draftChanged') : '';
}
function renderLesson(): void {
  const goals = { baseline: 'baselineGoal', overwrite: 'overwriteGoal', recompute: 'recomputeGoal' } as const;
  required('lesson-goal').textContent = activeLesson ? message(goals[activeLesson]) : '';
  for (const button of document.querySelectorAll<HTMLElement>('[data-lesson]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lesson === activeLesson));
  }
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
  exportReady = true;
  required('export-status').textContent = message('exported');
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
  pagingNotice = null;
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

function beginIntent(): number {
  const intent = ++latestIntent;
  workerClient.cancel();
  state.error = null;
  state.pending = true;
  cancelled = false;
  importNotice = null;
  importStatus.textContent = '';
  setLamp('running');
  renderRunStatus();
  return intent;
}

function failIntent(error: unknown, context: ErrorContext = 'run'): void {
  state.pending = false;
  state.error = { error, context };
  setLamp('fail');
  renderRunStatus();
}

async function importExperiment(): Promise<void> {
  const intent = beginIntent(); // Invalid new attempts also supersede old work.
  try {
    if (importInput.value.length > MAX_DOCUMENT_BYTES) {
      throw new LabError('INPUT', `experiment document must be at most ${MAX_DOCUMENT_BYTES} characters`);
    }
    const documentValue = parseExperimentDocument(importInput.value, MAX_DOCUMENT_BYTES);
    const pool = replayPaging(documentValue.paging.pageSize, documentValue.paging.pageCount,
      documentValue.paging.operations);
    const envelope = await workerClient.run(documentValue.input);
    if (intent !== latestIntent) return;
    // One synchronous commit: no input, paging or result changes before this guard.
    tokensInput.value = documentValue.input.tokens.join(', ');
    seedInput.value = String(documentValue.input.seed);
    setCheckedFault(documentValue.input.fault);
    commitImportedPaging(documentValue, pool);
    renderFaultTeaching();
    commitResult(documentValue.input, envelope);
    activeLesson = null;
    renderLesson();
    importNotice = { key: 'imported', values: { tokens: documentValue.input.tokens.length, operations: documentValue.paging.operations.length } };
    importStatus.textContent = noticeText(importNotice);
  } catch (error) {
    if (intent !== latestIntent) return;
    failIntent(error, 'import');
    importNotice = state.error;
    importStatus.textContent = noticeText(importNotice);
  }
}

async function runOnce(): Promise<void> {
  const intent = beginIntent();
  try {
    const input = readInput();
    const envelope = await workerClient.run(input);
    if (intent !== latestIntent) return;
    commitResult(input, envelope);
  } catch (error) {
    if (intent !== latestIntent) return;
    failIntent(error);
  }
}

required<HTMLFormElement>('scenario-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runOnce();
});
required<HTMLFormElement>('paging-form').addEventListener('submit', (event) => event.preventDefault());
required('cancel-button').addEventListener('click', () => {
  latestIntent += 1;
  workerClient.cancel();
  state.pending = false;
  state.error = null;
  cancelled = true;
  setLamp(state.result === null ? 'idle' : state.result.comparison.passes ? 'pass' : 'fail');
  renderRunStatus();
});
for (const id of LESSON_IDS) {
  document.querySelector<HTMLButtonElement>(`[data-lesson="${id}"]`)!.addEventListener('click', () => {
    const input = lessonInput(id);
    tokensInput.value = input.tokens.join(', ');
    seedInput.value = String(input.seed);
    setCheckedFault(input.fault);
    activeLesson = id;
    renderLesson();
    renderFaultTeaching();
    renderIdentity();
    void runOnce();
  });
}
for (const [id, action] of [['previous-position', 'previous'], ['next-position', 'next'],
  ['first-divergence-button', 'divergence']] as const) {
  required(id).addEventListener('click', () => navigate(action));
}
captureBar.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const keys: Record<string, PositionAction> = { ArrowLeft: 'previous', ArrowRight: 'next', Home: 'home', End: 'end' };
  const action = keys[event.key];
  if (!action) return;
  event.preventDefault();
  // Navigation starts from the focused column, even if it was reached by Tab.
  const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-position]');
  if (focused) state.selectedPosition = Number(focused.dataset.position);
  navigate(action, true);
});
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    if (!event.repeat) void runOnce();
  }
});
for (const input of [tokensInput, seedInput]) input.addEventListener('input', () => {
  activeLesson = null;
  renderLesson();
  renderIdentity();
});

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="fault"]')) {
  radio.addEventListener('change', () => {
    activeLesson = null;
    renderLesson();
    renderFaultTeaching();
    renderIdentity();
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

const themeSelect = required<HTMLSelectElement>('theme-select');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference: ThemePreference = 'system';
try { themePreference = readTheme(window.localStorage); } catch { /* Storage getter itself can throw. */ }
function applyTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(themePreference, systemTheme.matches);
  document.documentElement.dataset.themePreference = themePreference;
  themeSelect.value = themePreference;
}
themeSelect.addEventListener('change', () => {
  const value = themeSelect.value;
  themePreference = value === 'light' || value === 'dark' ? value : 'system';
  applyTheme();
  try { saveTheme(window.localStorage, themePreference); } catch { /* Still switch without storage. */ }
});
systemTheme.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
  link.addEventListener('click', () => {
    const target = document.getElementById(link.hash.slice(1));
    const details = target?.closest('details');
    if (details) details.open = true;
  });
}
async function initialize(): Promise<void> {
  applyTheme();
  applyLanguage();
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
