import { MODEL_SPEC, validateSeed } from '../contracts/index.js';

export interface LayerWeights {
  q: Float32Array;
  k: Float32Array;
  v: Float32Array;
  o: Float32Array;
  up: Float32Array;
  down: Float32Array;
}

export interface Model {
  id: string;
  seed: number;
  embeddings: Float32Array;
  positions: Float32Array;
  layers: LayerWeights[];
  lmHead: Float32Array;
}

const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const UINT32_MODULUS = 4294967296;
const WEIGHT_SCALE = 0.6;

class WeightStream {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (Math.imul(this.state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return Math.fround((this.state / UINT32_MODULUS - 0.5) * WEIGHT_SCALE);
  }

  matrix(rows: number, columns: number): Float32Array {
    const matrix = new Float32Array(rows * columns);
    for (let index = 0; index < matrix.length; index += 1) {
      matrix[index] = this.next();
    }
    return matrix;
  }
}

export function createModel(seed: number): Model {
  const checked = validateSeed(seed);
  const stream = new WeightStream(checked);
  const embeddings = stream.matrix(MODEL_SPEC.vocabSize, MODEL_SPEC.modelDim);
  const positions = stream.matrix(MODEL_SPEC.maxContext, MODEL_SPEC.modelDim);
  const layers: LayerWeights[] = [];
  for (let layer = 0; layer < MODEL_SPEC.numLayers; layer += 1) {
    layers.push({
      q: stream.matrix(MODEL_SPEC.modelDim, MODEL_SPEC.modelDim),
      k: stream.matrix(MODEL_SPEC.modelDim, MODEL_SPEC.modelDim),
      v: stream.matrix(MODEL_SPEC.modelDim, MODEL_SPEC.modelDim),
      o: stream.matrix(MODEL_SPEC.modelDim, MODEL_SPEC.modelDim),
      up: stream.matrix(MODEL_SPEC.modelDim, MODEL_SPEC.ffDim),
      down: stream.matrix(MODEL_SPEC.ffDim, MODEL_SPEC.modelDim),
    });
  }
  const lmHead = stream.matrix(MODEL_SPEC.modelDim, MODEL_SPEC.ffDim);
  return { id: MODEL_SPEC.id, seed: checked, embeddings, positions, layers, lmHead };
}

export async function weightsFingerprint(model: Model): Promise<string> {
  const arrays: Float32Array[] = [
    model.embeddings,
    model.positions,
    ...model.layers.flatMap((layer) => [layer.q, layer.k, layer.v, layer.o, layer.up, layer.down]),
    model.lmHead,
  ];
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const buffer = new ArrayBuffer(total * 4);
  const view = new DataView(buffer);
  let offset = 0;
  for (const array of arrays) {
    for (const value of array) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
