import {
  LabError,
  MODEL_SPEC,
  validateInput,
  type ExperimentInput,
  type FaultMode,
} from '../contracts/index.js';
import { CachedDecoder, fullForward, type CacheEvent, type CacheSnapshotLayer, type StepWorkStats } from './decoder.js';
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

export interface CompareOptions {
  atol?: number;
  rtol?: number;
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
 * Reported relative error uses max(|reference|, atol) as its scale so a zero
 * reference still yields a finite, interpretable number.
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
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
    maxRelativeError = Math.max(
      maxRelativeError,
      error / Math.max(Math.abs(referenceValue), atol),
    );
    if (firstMismatch === null && error > atol + rtol * Math.abs(referenceValue)) {
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

/**
 * Runs the full-prefix and cached decoders on the validated input, compares
 * every logit and layer hidden vector at every position plus the final cache,
 * and returns a deterministic report with no timestamps or host data.
 */
export async function runExperiment(input: unknown): Promise<ExperimentResult> {
  const validated = validateInput(input);
  const model = createModel(validated.seed);
  const weightsSha256 = await weightsFingerprint(model);
  const full = fullForward(model, validated.tokens);
  const decoder = new CachedDecoder(model, validated.fault);

  const vocab = MODEL_SPEC.vocabSize;
  const width = MODEL_SPEC.modelDim;
  const steps: ExperimentStep[] = [];
  let firstDivergence: number | null = null;
  let maxAbsoluteError = 0;
  let maxRelativeError = 0;
  let totalRecomputeTokens = 0;
  let totalKvReadSlots = 0;
  let totalAttentionMacs = 0;

  for (let position = 0; position < validated.tokens.length; position += 1) {
    const step = decoder.step(validated.tokens[position]);
    const fullRow = full.logits.subarray(position * vocab, (position + 1) * vocab);
    const logits = compareVectors(step.logits, fullRow);
    const hidden: LayerComparison[] = step.hidden.map((hiddenState, layer) => ({
      layer,
      comparison: compareVectors(
        hiddenState,
        full.hidden[layer]!.subarray(position * width, (position + 1) * width),
      ),
    }));
    const stepFails = !logits.passes || hidden.some((entry) => !entry.comparison.passes);
    if (stepFails && firstDivergence === null) {
      firstDivergence = position;
    }
    for (const comparison of [logits, ...hidden.map((entry) => entry.comparison)]) {
      maxAbsoluteError = Math.max(maxAbsoluteError, comparison.maxAbsoluteError);
      maxRelativeError = Math.max(maxRelativeError, comparison.maxRelativeError);
    }
    const work = copyWork(step.work);
    totalRecomputeTokens += work.recomputeTokens;
    totalKvReadSlots += work.kvReadSlots;
    totalAttentionMacs += work.attentionMacs;
    steps.push({
      position,
      token: step.token,
      fullLogits: toNumbers(fullRow),
      cachedLogits: toNumbers(step.logits),
      logits,
      hidden,
      cacheEvents: step.cacheEvents.map(copyCacheEvent),
      work,
    });
  }

  const snapshot: CacheSnapshotLayer[] = decoder.snapshot();
  const cache = compareVectors(flattenCache(snapshot), flattenCache(full.cache));
  maxAbsoluteError = Math.max(maxAbsoluteError, cache.maxAbsoluteError);
  maxRelativeError = Math.max(maxRelativeError, cache.maxRelativeError);
  firstDivergence = resolveFirstDivergence(firstDivergence, cache.passes, validated.tokens.length);
  const passes = firstDivergence === null;

  return {
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
    steps,
    comparison: {
      passes,
      firstDivergence,
      stepsCompared: steps.length,
      maxAbsoluteError,
      maxRelativeError,
      cache,
    },
    workSummary: {
      totalRecomputeTokens,
      expectedCachedTokens: steps.length,
      totalKvReadSlots,
      totalAttentionMacs,
      complexityClass: complexityFor(validated.fault),
    },
    finalCache: snapshot.map((layer, index) => ({
      layer: index,
      rows: layer.length,
      keys: toNumbers(layer.keys),
      values: toNumbers(layer.values),
    })),
  };
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
