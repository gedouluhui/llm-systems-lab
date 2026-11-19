import {
  LabError,
  MODEL_SPEC,
  validateInput,
  type ExperimentInput,
  type FaultMode,
} from '../contracts/index.js';
import {
  CachedDecoder,
  fullForward,
  type CacheEvent,
  type CacheSnapshotLayer,
  type FullForwardResult,
  type StepResult,
  type StepWorkStats,
} from './decoder.js';
import { createModel, weightsFingerprint } from './model.js';

export const ENGINE_VERSION = '0.1.0-a1';

export const TOLERANCES = Object.freeze({ atol: 1e-5, rtol: 1e-4 });

export interface VectorComparison {
  passes: boolean;
  length: number;
  maxAbsoluteError: number;
  maxRelativeError: number;
  firstMismatch: number | null;
}

export interface LayerComparison {
  layer: number;
  comparison: VectorComparison;
}

export interface ExperimentStep {
  position: number;
  token: number;
  fullLogits: number[];
  cachedLogits: number[];
  logits: VectorComparison;
  hidden: LayerComparison[];
  cacheEvents: CacheEvent[];
  work: StepWorkStats;
}

export type ComplexityClass =
  | 'O(T) step / O(T^2) total'
  | 'O(T^2) step / O(T^3) total'
  | 'O(1) masked';

export interface ExperimentWorkSummary {
  totalRecomputeTokens: number;
  /** One token is cached per step, so this equals stepsCompared. */
  expectedCachedTokens: number;
  totalKvReadSlots: number;
  totalAttentionMacs: number;
  complexityClass: ComplexityClass;
}

export interface ExperimentComparison {
  passes: boolean;
  /**
   * Earliest position whose logits or hidden state diverge. If only the final
   * cache diverges, this is the last position, because the cache is the state
   * produced there. This is null exactly when `passes` is true.
   */
  firstDivergence: number | null;
  stepsCompared: number;
  maxAbsoluteError: number;
  maxRelativeError: number;
  cache: VectorComparison;
}

export interface ExperimentModelInfo {
  id: string;
  untrained: true;
  weightsSha256: string;
  storage: 'float32';
  accumulation: 'float64';
}

export interface FinalCacheLayer {
  layer: number;
  rows: number;
  keys: number[];
  values: number[];
}

export interface ExperimentResult {
  schemaVersion: 1;
  engineVersion: string;
  mode: 'numerical';
  model: ExperimentModelInfo;
  input: ExperimentInput;
  tolerances: { atol: number; rtol: number };
  steps: ExperimentStep[];
  comparison: ExperimentComparison;
  workSummary: ExperimentWorkSummary;
  finalCache: FinalCacheLayer[];
}

/** Local elapsed wall time, never part of a deterministic report. */
export interface ExperimentTiming {
  fullForwardMs: number;
  cachedDecoderMs: number;
  totalMs: number;
}

export interface TimedExperimentResult<T> {
  result: T;
  timing: ExperimentTiming;
}

export interface TopKLogit {
  tokenId: number;
  logit: number;
}

export interface LightExperimentStep extends Omit<ExperimentStep, 'fullLogits' | 'cachedLogits'> {
  logitsLength: number;
  fullTopK: TopKLogit[];
  cachedTopK: TopKLogit[];
}

export interface LightFinalCacheLayer {
  layer: number;
  rows: number;
  columns: number;
}

/** A compact report, not a full report with optional or missing tensors. */
export interface LightExperimentResult extends Omit<ExperimentResult, 'steps' | 'finalCache'> {
  detail: 'light';
  topK: number;
  steps: LightExperimentStep[];
  finalCache: LightFinalCacheLayer[];
}

export interface FullExperimentOptions {
  detail: 'full';
  topK?: never;
}

export interface LightExperimentOptions {
  detail: 'light';
  topK?: number;
}

export type ExperimentOptions = FullExperimentOptions | LightExperimentOptions;

type ValidatedOptions = FullExperimentOptions | { detail: 'light'; topK: number };

export interface CompareOptions {
  atol?: number;
  rtol?: number;
}

function validateTopK(k: unknown, length: number): number {
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > length) {
    throw new LabError('INPUT', `topK must be an integer in [1, ${length}]`);
  }
  return k;
}

function validateOptions(options: unknown): ValidatedOptions {
  if (options === undefined) {
    return { detail: 'full' };
  }
  if (!isPlainRecord(options)) {
    throw new LabError('INPUT', 'experiment options must be a plain data record');
  }
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'detail' && key !== 'topK') {
      throw new LabError('INPUT', 'experiment options may only contain detail and topK');
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new LabError('INPUT', 'experiment options must contain only data properties');
    }
    fields.set(key, descriptor.value);
  }
  const detail = fields.get('detail');
  if (detail === 'full') {
    if (fields.has('topK')) {
      throw new LabError('INPUT', 'topK is only supported for light reports');
    }
    return { detail };
  }
  if (detail === 'light') {
    return {
      detail,
      topK: fields.has('topK') ? validateTopK(fields.get('topK'), MODEL_SPEC.vocabSize) : 5,
    };
  }
  throw new LabError('INPUT', 'detail must be "full" or "light"');
}

/** Rank every finite logit, keeping at most k entries; ties use ascending token id. */
export function topKLogits(vector: unknown, k: number): TopKLogit[] {
  if (!isVector(vector) || vector.length === 0) {
    throw new LabError('INPUT', 'logits must be a nonempty numeric vector');
  }
  const count = validateTopK(k, vector.length);
  const top: TopKLogit[] = [];
  for (let tokenId = 0; tokenId < vector.length; tokenId += 1) {
    const value: unknown = vector[tokenId];
    if (typeof value !== 'number') {
      throw new LabError('INPUT', 'logits must contain numbers');
    }
    if (!Number.isFinite(value)) {
      throw new LabError('NON_FINITE', 'logits must contain only finite values');
    }
    const logit = value === 0 ? 0 : value;
    let rank = 0;
    // Token ids arrive in ascending order, so earlier equal logits stay first.
    while (rank < top.length && top[rank]!.logit >= logit) {
      rank += 1;
    }
    if (rank < count) {
      top.splice(rank, 0, { tokenId, logit });
      if (top.length > count) {
        top.pop();
      }
    }
  }
  return top;
}

function isVector(value: unknown): value is ArrayLike<number> {
  return Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkTolerance(name: string, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LabError('INPUT', `${name} must be a finite non-negative number`);
  }
  return value;
}

/**
 * Compares two equal-length numeric vectors with the numerical contract's
 * tolerance: |actual - reference| <= atol + rtol * |reference| (inclusive).
 * Reported relative error is zero for equal values, otherwise error divided
 * by max(|reference|, atol); a zero scale or ratio overflow yields Infinity.
 * Non-finite differences or tolerance thresholds throw NON_FINITE.
 */
export function compareVectors(
  actual: unknown,
  reference: unknown,
  options: CompareOptions = {},
): VectorComparison {
  const atol = checkTolerance('atol', options.atol) ?? TOLERANCES.atol;
  const rtol = checkTolerance('rtol', options.rtol) ?? TOLERANCES.rtol;
  if (!isVector(actual) || !isVector(reference)) {
    throw new LabError('INPUT', 'both comparison operands must be numeric vectors');
  }
  if (actual.length === 0 || reference.length === 0) {
    throw new LabError('INPUT', 'comparison vectors must not be empty');
  }
  if (actual.length !== reference.length) {
    throw new LabError('INPUT', `vector lengths differ: ${actual.length} !== ${reference.length}`);
  }

  let maxAbsoluteError = 0;
  let maxRelativeError = 0;
  let firstMismatch: number | null = null;
  for (let index = 0; index < actual.length; index += 1) {
    const actualValue: unknown = actual[index];
    const referenceValue: unknown = reference[index];
    if (typeof actualValue !== 'number' || typeof referenceValue !== 'number') {
      throw new LabError('INPUT', 'comparison vectors must contain numbers');
    }
    if (!Number.isFinite(actualValue) || !Number.isFinite(referenceValue)) {
      throw new LabError('NON_FINITE', 'comparison vectors must contain only finite values');
    }
    const error = Math.abs(actualValue - referenceValue);
    const threshold = atol + rtol * Math.abs(referenceValue);
    if (!Number.isFinite(error) || !Number.isFinite(threshold)) {
      throw new LabError('NON_FINITE', 'comparison difference or tolerance threshold overflowed');
    }
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
    maxRelativeError = Math.max(
      maxRelativeError,
      error === 0 ? 0 : error / Math.max(Math.abs(referenceValue), atol),
    );
    if (firstMismatch === null && error > threshold) {
      firstMismatch = index;
    }
  }

  return {
    passes: firstMismatch === null,
    length: actual.length,
    maxAbsoluteError,
    maxRelativeError,
    firstMismatch,
  };
}

function toNumbers(values: ArrayLike<number>): number[] {
  const numbers: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    numbers.push(value === 0 ? 0 : value);
  }
  return numbers;
}

function flattenCache(
  layers: ReadonlyArray<{ keys: ArrayLike<number>; values: ArrayLike<number> }>,
): Float32Array {
  let total = 0;
  for (const layer of layers) {
    total += layer.keys.length + layer.values.length;
  }
  const flat = new Float32Array(total);
  let offset = 0;
  for (const layer of layers) {
    flat.set(layer.keys, offset);
    offset += layer.keys.length;
    flat.set(layer.values, offset);
    offset += layer.values.length;
  }
  return flat;
}

function copyCacheEvent(event: CacheEvent): CacheEvent {
  return {
    layer: event.layer,
    writeSlot: event.writeSlot,
    readSlots: [...event.readSlots],
    overwrittenSlot: event.overwrittenSlot,
  };
}

function copyWork(work: StepWorkStats): StepWorkStats {
  return {
    recomputeTokens: work.recomputeTokens,
    kvReadSlots: work.kvReadSlots,
    attentionMacs: work.attentionMacs,
  };
}

/**
 * The asymptotic class of the mode, fixed in advance. The measured ledger is
 * the evidence; this label never changes because a sample happened to be short.
 */
function complexityFor(fault: FaultMode): ComplexityClass {
  if (fault === 'no-cache-recompute') {
    return 'O(T^2) step / O(T^3) total';
  }
  if (fault === 'mask-current-only') {
    return 'O(1) masked';
  }
  return 'O(T) step / O(T^2) total';
}

/**
 * Maps per-step and final-cache comparisons to the reported divergence
 * position. A final-cache-only mismatch belongs to the last token, because the
 * final cache is the state produced there. The result is null exactly when
 * every step vector and the final cache agree.
 */
export function resolveFirstDivergence(
  stepDivergence: number | null,
  cachePasses: boolean,
  tokenCount: number,
): number | null {
  if (stepDivergence !== null || cachePasses) {
    return stepDivergence;
  }
  return tokenCount - 1;
}

interface ComparedStep extends Omit<ExperimentStep, 'fullLogits' | 'cachedLogits'> {
  fullRow: Float32Array;
  cachedRow: Float32Array;
}

/** Shared by both report formats and prefix expansion, before any projection. */
function compareStep(full: FullForwardResult, step: StepResult): ComparedStep {
  const position = step.position;
  const vocab = MODEL_SPEC.vocabSize;
  const width = MODEL_SPEC.modelDim;
  const fullRow = full.logits.subarray(position * vocab, (position + 1) * vocab);
  return {
    position,
    token: step.token,
    fullRow,
    cachedRow: step.logits,
    logits: compareVectors(step.logits, fullRow),
    hidden: step.hidden.map((hiddenState, layer) => ({
      layer,
      comparison: compareVectors(
        hiddenState,
        full.hidden[layer]!.subarray(position * width, (position + 1) * width),
      ),
    })),
    cacheEvents: step.cacheEvents.map(copyCacheEvent),
    work: copyWork(step.work),
  };
}

function fullStep(step: ComparedStep): ExperimentStep {
  return {
    position: step.position,
    token: step.token,
    fullLogits: toNumbers(step.fullRow),
    cachedLogits: toNumbers(step.cachedRow),
    logits: step.logits,
    hidden: step.hidden,
    cacheEvents: step.cacheEvents,
    work: step.work,
  };
}

function lightStep(step: ComparedStep, topK: number): LightExperimentStep {
  const { fullRow, cachedRow, ...common } = step;
  return {
    ...common,
    logitsLength: fullRow.length,
    fullTopK: topKLogits(fullRow, topK),
    cachedTopK: topKLogits(cachedRow, topK),
  };
}

/**
 * Runs both decoders and compares all logits, hidden vectors and the final
 * cache. Light detail only reduces report materialization, not forward work.
 * Omitting options preserves the full report, including its JSON field order.
 */
export function runExperiment(input: unknown, options?: FullExperimentOptions): Promise<ExperimentResult>;
export function runExperiment(input: unknown, options: LightExperimentOptions): Promise<LightExperimentResult>;
export function runExperiment(
  input: unknown,
  options?: ExperimentOptions,
): Promise<ExperimentResult | LightExperimentResult>;
export async function runExperiment(
  input: unknown,
  options?: ExperimentOptions,
): Promise<ExperimentResult | LightExperimentResult> {
  return runSharedExperiment(input, options);
}

export function runTimedExperiment(input: unknown, options?: FullExperimentOptions): Promise<TimedExperimentResult<ExperimentResult>>;
export function runTimedExperiment(input: unknown, options: LightExperimentOptions): Promise<TimedExperimentResult<LightExperimentResult>>;
export function runTimedExperiment(input: unknown, options?: ExperimentOptions): Promise<TimedExperimentResult<ExperimentResult | LightExperimentResult>>;
export async function runTimedExperiment(
  input: unknown,
  options?: ExperimentOptions,
): Promise<TimedExperimentResult<ExperimentResult | LightExperimentResult>> {
  const started = performance.now();
  const timing: ExperimentTiming = { fullForwardMs: 0, cachedDecoderMs: 0, totalMs: 0 };
  const result = await runSharedExperiment(input, options, timing);
  timing.totalMs = performance.now() - started;
  return { result, timing };
}

async function runSharedExperiment(
  input: unknown,
  options?: ExperimentOptions,
  timing?: ExperimentTiming,
): Promise<ExperimentResult | LightExperimentResult> {
  const validated = validateInput(input);
  const detail = validateOptions(options);
  const model = createModel(validated.seed);
  const weightsSha256 = await weightsFingerprint(model);
  const fullStarted = timing === undefined ? 0 : performance.now();
  const full = fullForward(model, validated.tokens);
  if (timing !== undefined) {
    timing.fullForwardMs = performance.now() - fullStarted;
  }
  const decoder = new CachedDecoder(model, validated.fault);

  const report: { detail: 'full'; steps: ExperimentStep[] }
    | { detail: 'light'; topK: number; steps: LightExperimentStep[] } = { ...detail, steps: [] };
  let firstDivergence: number | null = null;
  let maxAbsoluteError = 0;
  let maxRelativeError = 0;
  let totalRecomputeTokens = 0;
  let totalKvReadSlots = 0;
  let totalAttentionMacs = 0;

  for (let position = 0; position < validated.tokens.length; position += 1) {
    const stepStarted = timing === undefined ? 0 : performance.now();
    const decoded = decoder.step(validated.tokens[position]);
    if (timing !== undefined) {
      timing.cachedDecoderMs += performance.now() - stepStarted;
    }
    const step = compareStep(full, decoded);
    const { logits, hidden, work } = step;
    const stepFails = !logits.passes || hidden.some((entry) => !entry.comparison.passes);
    if (stepFails && firstDivergence === null) {
      firstDivergence = position;
    }
    for (const comparison of [logits, ...hidden.map((entry) => entry.comparison)]) {
      maxAbsoluteError = Math.max(maxAbsoluteError, comparison.maxAbsoluteError);
      maxRelativeError = Math.max(maxRelativeError, comparison.maxRelativeError);
    }
    totalRecomputeTokens += work.recomputeTokens;
    totalKvReadSlots += work.kvReadSlots;
    totalAttentionMacs += work.attentionMacs;
    if (report.detail === 'light') {
      report.steps.push(lightStep(step, report.topK));
    } else {
      report.steps.push(fullStep(step));
    }
  }

  const snapshot: CacheSnapshotLayer[] = decoder.snapshot();
  const cache = compareVectors(flattenCache(snapshot), flattenCache(full.cache));
  maxAbsoluteError = Math.max(maxAbsoluteError, cache.maxAbsoluteError);
  maxRelativeError = Math.max(maxRelativeError, cache.maxRelativeError);
  firstDivergence = resolveFirstDivergence(firstDivergence, cache.passes, validated.tokens.length);
  const passes = firstDivergence === null;

  const metadata: Omit<ExperimentResult, 'steps' | 'comparison' | 'workSummary' | 'finalCache'> = {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    mode: 'numerical',
    model: {
      id: MODEL_SPEC.id,
      untrained: true,
      weightsSha256,
      storage: 'float32',
      accumulation: 'float64',
    },
    input: validated,
    tolerances: { atol: TOLERANCES.atol, rtol: TOLERANCES.rtol },
  };
  const comparison: ExperimentComparison = {
    passes,
    firstDivergence,
    stepsCompared: report.steps.length,
    maxAbsoluteError,
    maxRelativeError,
    cache,
  };
  const workSummary: ExperimentWorkSummary = {
    totalRecomputeTokens,
    expectedCachedTokens: report.steps.length,
    totalKvReadSlots,
    totalAttentionMacs,
    complexityClass: complexityFor(validated.fault),
  };
  if (report.detail === 'light') {
    return {
      ...metadata,
      detail: 'light',
      topK: report.topK,
      steps: report.steps,
      comparison,
      workSummary,
      finalCache: snapshot.map((layer, index) => ({
        layer: index,
        rows: layer.length,
        columns: MODEL_SPEC.modelDim,
      })),
    };
  }
  return {
    ...metadata,
    steps: report.steps,
    comparison,
    workSummary,
    finalCache: snapshot.map((layer, index) => ({
      layer: index,
      rows: layer.length,
      keys: toNumbers(layer.keys),
      values: toNumbers(layer.values),
    })),
  };
}

/** Replay 0..position with cache history intact; materialize only the requested step. */
export async function expandExperimentStep(input: unknown, position: number): Promise<ExperimentStep> {
  const validated = validateInput(input);
  if (typeof position !== 'number' || !Number.isInteger(position)
    || position < 0 || position >= validated.tokens.length) {
    throw new LabError('INPUT', 'position must be an integer within the input token sequence');
  }
  const prefix = validated.tokens.slice(0, position + 1);
  const model = createModel(validated.seed);
  const full = fullForward(model, prefix);
  const decoder = new CachedDecoder(model, validated.fault);
  for (let index = 0; index < position; index += 1) {
    decoder.step(prefix[index]);
  }
  return fullStep(compareStep(full, decoder.step(prefix[position])));
}

/**
 * Recomputes a report from its validated input and only trusts the recorded
 * metadata needed to reject incompatible or substituted reports. Recorded
 * steps and comparison fields are ignored.
 */
export async function replayExperiment(report: unknown): Promise<ExperimentResult> {
  if (!isPlainRecord(report)) {
    throw new LabError('INPUT', 'replay report must be a plain object');
  }
  if (report.schemaVersion !== 1) {
    throw new LabError('INPUT', 'replay report has an unsupported schemaVersion');
  }
  if (report.engineVersion !== ENGINE_VERSION) {
    throw new LabError('INPUT', `replay report engineVersion must be "${ENGINE_VERSION}"`);
  }
  const model = report.model;
  if (!isPlainRecord(model)) {
    throw new LabError('INPUT', 'replay report must contain a model record');
  }
  if (model.id !== MODEL_SPEC.id) {
    throw new LabError('INPUT', `replay report model id must be "${MODEL_SPEC.id}"`);
  }
  if (typeof model.weightsSha256 !== 'string') {
    throw new LabError('INPUT', 'replay report must contain a weight fingerprint');
  }

  const result = await runExperiment(report.input);
  if (result.model.weightsSha256 !== model.weightsSha256) {
    throw new LabError('INPUT', 'recorded weight fingerprint does not match the regenerated model');
  }
  return result;
}
