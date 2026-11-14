export type FaultMode =
  | 'none'
  | 'position-offset'
  | 'cache-overwrite'
  | 'mask-current-only'
  | 'no-cache-recompute';

export type LabErrorCode = 'INPUT' | 'CONTEXT_LIMIT' | 'NON_FINITE' | 'OOM';

export interface ExperimentInput {
  schemaVersion: 1;
  seed: number;
  tokens: number[];
  fault: FaultMode;
}

export const MODEL_SPEC = Object.freeze({
  id: 'tiny-decoder-v1',
  vocabSize: 32,
  maxContext: 64,
  numLayers: 2,
  numHeads: 2,
  headDim: 8,
  modelDim: 16,
  ffDim: 32,
  layerNormEpsilon: 1e-5,
});

export const FAULTS: readonly FaultMode[] = Object.freeze([
  'none',
  'position-offset',
  'cache-overwrite',
  'mask-current-only',
  'no-cache-recompute',
] as const);

const INPUT_KEYS = ['schemaVersion', 'seed', 'tokens', 'fault'] as const;

export class LabError extends Error {
  readonly code: LabErrorCode;

  constructor(code: LabErrorCode, message: string) {
    super(message);
    this.name = 'LabError';
    this.code = code;
  }
}

function fail(code: LabErrorCode, message: string): never {
  throw new LabError(code, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readFields(value: Record<string, unknown>): Map<string, unknown> {
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail('INPUT', 'input must not contain symbol keys');
  }
  for (const name of names) {
    if (!(INPUT_KEYS as readonly string[]).includes(name)) {
      fail('INPUT', `unexpected input key "${name}"`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('INPUT', `input field "${name}" must be a data property`);
    }
  }
  const fields = new Map<string, unknown>();
  for (const name of INPUT_KEYS) {
    if (!names.includes(name)) {
      fail('INPUT', `missing input field "${name}"`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('INPUT', `input field "${name}" must be a data property`);
    }
    fields.set(name, descriptor.value);
  }
  return fields;
}

export function validateSeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4294967295) {
    fail('INPUT', 'seed must be an integer in [0, 4294967295]');
  }
  return value === 0 ? 0 : value;
}

export function validateTokens(value: unknown): number[] {
  if (!Array.isArray(value)) {
    fail('INPUT', 'tokens must be an array of integers in [0, 31]');
  }
  const length = value.length;
  if (length === 0) {
    fail('INPUT', 'tokens must not be empty');
  }
  if (length > MODEL_SPEC.maxContext) {
    fail('CONTEXT_LIMIT', `tokens length ${length} exceeds maximum context ${MODEL_SPEC.maxContext}`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail('INPUT', 'tokens must not contain symbol properties');
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === 'length') {
      continue;
    }
    const isIndex = /^(0|[1-9][0-9]*)$/.test(name) && Number(name) < length;
    if (!isIndex) {
      fail('INPUT', `unexpected array property "${name}"`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('INPUT', 'token elements must be data properties');
    }
  }
  const tokens: number[] = new Array<number>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('INPUT', 'tokens must be dense; holes and accessors are not allowed');
    }
    const token = descriptor.value;
    if (typeof token !== 'number' || !Number.isInteger(token) || token < 0 || token >= MODEL_SPEC.vocabSize) {
      fail('INPUT', `token at index ${index} must be an integer in [0, 31]`);
    }
    tokens[index] = token === 0 ? 0 : token;
  }
  return tokens;
}

export function validateInput(value: unknown): ExperimentInput {
  if (!isPlainRecord(value)) {
    fail('INPUT', 'input must be a plain data record');
  }
  const fields = readFields(value);
  if (fields.get('schemaVersion') !== 1) {
    fail('INPUT', 'schemaVersion must be exactly 1');
  }
  const seed = validateSeed(fields.get('seed'));
  const tokens = validateTokens(fields.get('tokens'));
  const fault = fields.get('fault');
  if (typeof fault !== 'string' || !(FAULTS as readonly string[]).includes(fault)) {
    fail('INPUT', 'fault must be one of the documented modes');
  }
  return { schemaVersion: 1, seed, tokens, fault: fault as FaultMode };
}
