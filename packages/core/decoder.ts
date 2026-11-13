import { FAULTS, LabError, MODEL_SPEC, validateTokens, type FaultMode } from '../contracts/index.js';
import type { Model } from './model.js';
import { dot, layerNorm, matmul, softmaxRow } from './math.js';

export interface CacheLayerView {
  keys: Float32Array;
  values: Float32Array;
}

export interface CacheSnapshotLayer extends CacheLayerView {
  length: number;
}

export interface CacheEvent {
  layer: number;
  writeSlot: number;
  readSlots: number[];
  overwrittenSlot: number | null;
}

export interface FullForwardResult {
  logits: Float32Array;
  hidden: Float32Array[];
  cache: CacheLayerView[];
}

export interface StepResult {
  position: number;
  token: number;
  logits: Float32Array;
  hidden: Float32Array[];
  cacheEvents: CacheEvent[];
}

function normalizeRows(state: Float32Array, rows: number, width: number): Float32Array {
  const normalized = new Float32Array(rows * width);
  for (let row = 0; row < rows; row += 1) {
    normalized.set(layerNorm(state, row * width, width), row * width);
  }
  return normalized;
}

/**
 * Y = float32(X + A Wo).  The projection and the residual addition share one
 * float64 accumulation per element, matching the independent NumPy reference.
 */
function residualFromAttention(
  state: Float32Array,
  attended: Float32Array,
  rows: number,
  width: number,
  output: Float32Array,
): Float32Array {
  const result = new Float32Array(rows * width);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let total = 0;
      for (let index = 0; index < width; index += 1) {
        total += attended[row * width + index]! * output[index * width + column]!;
      }
      result[row * width + column] = state[row * width + column]! + total;
    }
  }
  return result;
}

function ensureFinite(arrays: Float32Array[]): void {
  for (const array of arrays) {
    for (let index = 0; index < array.length; index += 1) {
      if (!Number.isFinite(array[index]!)) {
        throw new LabError('NON_FINITE', 'the forward pass produced a non-finite value');
      }
    }
  }
}

function validateStepToken(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MODEL_SPEC.vocabSize) {
    throw new LabError('INPUT', 'token must be an integer in [0, 31]');
  }
  return value === 0 ? 0 : value;
}

export function fullForward(model: Model, tokens: unknown): FullForwardResult {
  const ids = validateTokens(tokens);
  const length = ids.length;
  const width = MODEL_SPEC.modelDim;
  const headDim = MODEL_SPEC.headDim;
  const numHeads = MODEL_SPEC.numHeads;
  const scale = Math.sqrt(headDim);

  let hiddenState = new Float32Array(length * width);
  for (let position = 0; position < length; position += 1) {
    const token = ids[position]!;
    for (let dimension = 0; dimension < width; dimension += 1) {
      hiddenState[position * width + dimension] =
        model.embeddings[token * width + dimension]! +
        model.positions[position * width + dimension]!;
    }
  }

  const hidden: Float32Array[] = [];
  const cache: CacheLayerView[] = [];

  for (let layerIndex = 0; layerIndex < model.layers.length; layerIndex += 1) {
    const layer = model.layers[layerIndex]!;
    const normalized = normalizeRows(hiddenState, length, width);
    const q = matmul(normalized, length, width, layer.q, width);
    const k = matmul(normalized, length, width, layer.k, width);
    const v = matmul(normalized, length, width, layer.v, width);

    const attended = new Float32Array(length * width);
    for (let head = 0; head < numHeads; head += 1) {
      const headOffset = head * headDim;
      for (let position = 0; position < length; position += 1) {
        const scores = new Float64Array(position + 1);
        for (let slot = 0; slot <= position; slot += 1) {
          scores[slot] =
            dot(q, position * width + headOffset, k, slot * width + headOffset, headDim) / scale;
        }
        const probabilities = softmaxRow(scores, position + 1);
        for (let dimension = 0; dimension < headDim; dimension += 1) {
          let total = 0;
          for (let slot = 0; slot <= position; slot += 1) {
            total += probabilities[slot]! * v[slot * width + headOffset + dimension]!;
          }
          attended[position * width + headOffset + dimension] = total;
        }
      }
    }

    const residual = residualFromAttention(hiddenState, attended, length, width, layer.o);

    const ffNormalized = normalizeRows(residual, length, width);
    const up = matmul(ffNormalized, length, width, layer.up, MODEL_SPEC.ffDim);
    for (let index = 0; index < up.length; index += 1) {
      if (up[index]! < 0) {
        up[index] = 0;
      }
    }
    const down = matmul(up, length, MODEL_SPEC.ffDim, layer.down, width);

    const next = new Float32Array(length * width);
    for (let index = 0; index < next.length; index += 1) {
      next[index] = residual[index]! + down[index]!;
    }

    hiddenState = next;
    hidden.push(hiddenState);
    cache.push({ keys: k, values: v });
  }

  const finalNormalized = normalizeRows(hiddenState, length, width);
  const logits = matmul(finalNormalized, length, width, model.lmHead, MODEL_SPEC.vocabSize);
  ensureFinite([logits, ...hidden, ...cache.flatMap((layer) => [layer.keys, layer.values])]);
  return { logits, hidden, cache };
}

interface PendingLayer {
  keys: Float32Array;
  values: Float32Array;
  overwrittenSlot: number | null;
}

export class CachedDecoder {
  private readonly model: Model;
  private readonly fault: FaultMode;
  private readonly keys: Float32Array[];
  private readonly values: Float32Array[];
  private count = 0;

  constructor(model: Model, ...options: [unknown?]) {
    const fault: unknown = options.length === 0 ? 'none' : options[0];
    if (typeof fault !== 'string' || !(FAULTS as readonly string[]).includes(fault)) {
      throw new LabError('INPUT', 'fault must be one of the documented modes');
    }
    this.model = model;
    this.fault = fault as FaultMode;
    const capacity = MODEL_SPEC.maxContext * MODEL_SPEC.modelDim;
    this.keys = model.layers.map(() => new Float32Array(capacity));
    this.values = model.layers.map(() => new Float32Array(capacity));
  }

  get length(): number {
    return this.count;
  }

  step(token: unknown): StepResult {
    const checked = validateStepToken(token);
    if (this.count >= MODEL_SPEC.maxContext) {
      throw new LabError(
        'CONTEXT_LIMIT',
        `context limit ${MODEL_SPEC.maxContext} reached`,
      );
    }

    const position = this.count;
    const width = MODEL_SPEC.modelDim;
    const headDim = MODEL_SPEC.headDim;
    const numHeads = MODEL_SPEC.numHeads;
    const scale = Math.sqrt(headDim);
    const positionIndex =
      this.fault === 'position-offset' && position > 0
        ? (position + 1) % MODEL_SPEC.maxContext
        : position;

    let hidden = new Float32Array(width);
    for (let dimension = 0; dimension < width; dimension += 1) {
      hidden[dimension] =
        this.model.embeddings[checked * width + dimension]! +
        this.model.positions[positionIndex * width + dimension]!;
    }

    const hiddenLayers: Float32Array[] = [];
    const events: CacheEvent[] = [];
    const pending: PendingLayer[] = [];

    for (let layerIndex = 0; layerIndex < this.model.layers.length; layerIndex += 1) {
      const layer = this.model.layers[layerIndex]!;
      const cacheKeys = this.keys[layerIndex]!;
      const cacheValues = this.values[layerIndex]!;

      const normalized = layerNorm(hidden, 0, width);
      const q = matmul(normalized, 1, width, layer.q, width);
      const k = matmul(normalized, 1, width, layer.k, width);
      const v = matmul(normalized, 1, width, layer.v, width);

      const overwrittenSlot =
        this.fault === 'cache-overwrite' && position > 0 ? 0 : null;
      const readSlots =
        this.fault === 'mask-current-only'
          ? [position]
          : Array.from({ length: position + 1 }, (_, index) => index);

      const visibleKeys = new Float32Array(readSlots.length * width);
      const visibleValues = new Float32Array(readSlots.length * width);
      for (let index = 0; index < readSlots.length; index += 1) {
        const slot = readSlots[index]!;
        const fromNewRow = slot === position || slot === overwrittenSlot;
        for (let dimension = 0; dimension < width; dimension += 1) {
          visibleKeys[index * width + dimension] = fromNewRow
            ? k[dimension]!
            : cacheKeys[slot * width + dimension]!;
          visibleValues[index * width + dimension] = fromNewRow
            ? v[dimension]!
            : cacheValues[slot * width + dimension]!;
        }
      }

      const attended = new Float32Array(width);
      for (let head = 0; head < numHeads; head += 1) {
        const headOffset = head * headDim;
        const scores = new Float64Array(readSlots.length);
        for (let index = 0; index < readSlots.length; index += 1) {
          scores[index] =
            dot(q, headOffset, visibleKeys, index * width + headOffset, headDim) / scale;
        }
        const probabilities = softmaxRow(scores, readSlots.length);
        for (let dimension = 0; dimension < headDim; dimension += 1) {
          let total = 0;
          for (let index = 0; index < readSlots.length; index += 1) {
            total += probabilities[index]! * visibleValues[index * width + headOffset + dimension]!;
          }
          attended[headOffset + dimension] = total;
        }
      }

      const residual = residualFromAttention(hidden, attended, 1, width, layer.o);

      const ffNormalized = layerNorm(residual, 0, width);
      const up = matmul(ffNormalized, 1, width, layer.up, MODEL_SPEC.ffDim);
      for (let index = 0; index < up.length; index += 1) {
        if (up[index]! < 0) {
          up[index] = 0;
        }
      }
      const down = matmul(up, 1, MODEL_SPEC.ffDim, layer.down, width);

      const next = new Float32Array(width);
      for (let dimension = 0; dimension < width; dimension += 1) {
        next[dimension] = residual[dimension]! + down[dimension]!;
      }

      hidden = next;
      hiddenLayers.push(hidden);
      pending.push({ keys: k, values: v, overwrittenSlot });
      events.push({ layer: layerIndex, writeSlot: position, readSlots, overwrittenSlot });
    }

    const finalNormalized = layerNorm(hidden, 0, width);
    const logits = matmul(finalNormalized, 1, width, this.model.lmHead, MODEL_SPEC.vocabSize);
    ensureFinite([
      logits,
      ...hiddenLayers,
      ...pending.flatMap((item) => [item.keys, item.values]),
    ]);

    for (let layerIndex = 0; layerIndex < pending.length; layerIndex += 1) {
      const item = pending[layerIndex]!;
      const cacheKeys = this.keys[layerIndex]!;
      const cacheValues = this.values[layerIndex]!;
      if (item.overwrittenSlot !== null) {
        cacheKeys.set(item.keys, item.overwrittenSlot * width);
        cacheValues.set(item.values, item.overwrittenSlot * width);
      }
      cacheKeys.set(item.keys, position * width);
      cacheValues.set(item.values, position * width);
    }
    this.count = position + 1;

    return { position, token: checked, logits, hidden: hiddenLayers, cacheEvents: events };
  }

  snapshot(): CacheSnapshotLayer[] {
    const width = MODEL_SPEC.modelDim;
    const length = this.count;
    const snapshots: CacheSnapshotLayer[] = [];
    for (let layerIndex = 0; layerIndex < this.keys.length; layerIndex += 1) {
      snapshots.push({
        keys: this.keys[layerIndex]!.slice(0, length * width),
        values: this.values[layerIndex]!.slice(0, length * width),
        length,
      });
    }
    return snapshots;
  }

  reset(): void {
    this.count = 0;
    for (const keys of this.keys) {
      keys.fill(0);
    }
    for (const values of this.values) {
      values.fill(0);
    }
  }
}
