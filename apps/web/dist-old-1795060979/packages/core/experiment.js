import { LabError, MODEL_SPEC, validateInput, } from '../contracts/index.js';
import { CachedDecoder, fullForward, } from './decoder.js';
import { createModel, weightsFingerprint } from './model.js';
export const ENGINE_VERSION = '0.1.0-a1';
export const TOLERANCES = Object.freeze({ atol: 1e-5, rtol: 1e-4 });
function validateTopK(k, length) {
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > length) {
        throw new LabError('INPUT', `topK must be an integer in [1, ${length}]`);
    }
    return k;
}
function validateOptions(options) {
    if (options === undefined) {
        return { detail: 'full' };
    }
    if (!isPlainRecord(options)) {
        throw new LabError('INPUT', 'experiment options must be a plain data record');
    }
    const fields = new Map();
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
export function topKLogits(vector, k) {
    if (!isVector(vector) || vector.length === 0) {
        throw new LabError('INPUT', 'logits must be a nonempty numeric vector');
    }
    const count = validateTopK(k, vector.length);
    const top = [];
    for (let tokenId = 0; tokenId < vector.length; tokenId += 1) {
        const value = vector[tokenId];
        if (typeof value !== 'number') {
            throw new LabError('INPUT', 'logits must contain numbers');
        }
        if (!Number.isFinite(value)) {
            throw new LabError('NON_FINITE', 'logits must contain only finite values');
        }
        const logit = value === 0 ? 0 : value;
        let rank = 0;
        // Token ids arrive in ascending order, so earlier equal logits stay first.
        while (rank < top.length && top[rank].logit >= logit) {
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
function isVector(value) {
    return Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array;
}
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function checkTolerance(name, value) {
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
export function compareVectors(actual, reference, options = {}) {
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
    let firstMismatch = null;
    for (let index = 0; index < actual.length; index += 1) {
        const actualValue = actual[index];
        const referenceValue = reference[index];
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
        maxRelativeError = Math.max(maxRelativeError, error === 0 ? 0 : error / Math.max(Math.abs(referenceValue), atol));
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
function toNumbers(values) {
    const numbers = [];
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        numbers.push(value === 0 ? 0 : value);
    }
    return numbers;
}
function flattenCache(layers) {
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
function copyCacheEvent(event) {
    return {
        layer: event.layer,
        writeSlot: event.writeSlot,
        readSlots: [...event.readSlots],
        overwrittenSlot: event.overwrittenSlot,
    };
}
function copyWork(work) {
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
function complexityFor(fault) {
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
export function resolveFirstDivergence(stepDivergence, cachePasses, tokenCount) {
    if (stepDivergence !== null || cachePasses) {
        return stepDivergence;
    }
    return tokenCount - 1;
}
/** Shared by both report formats and prefix expansion, before any projection. */
function compareStep(full, step) {
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
            comparison: compareVectors(hiddenState, full.hidden[layer].subarray(position * width, (position + 1) * width)),
        })),
        cacheEvents: step.cacheEvents.map(copyCacheEvent),
        work: copyWork(step.work),
    };
}
function fullStep(step) {
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
function lightStep(step, topK) {
    const { fullRow, cachedRow, ...common } = step;
    return {
        ...common,
        logitsLength: fullRow.length,
        fullTopK: topKLogits(fullRow, topK),
        cachedTopK: topKLogits(cachedRow, topK),
    };
}
export async function runExperiment(input, options) {
    return runSharedExperiment(input, options);
}
export async function runTimedExperiment(input, options) {
    const started = performance.now();
    const timing = { fullForwardMs: 0, cachedDecoderMs: 0, totalMs: 0 };
    const result = await runSharedExperiment(input, options, timing);
    timing.totalMs = performance.now() - started;
    return { result, timing };
}
async function runSharedExperiment(input, options, timing) {
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
    const report = { ...detail, steps: [] };
    let firstDivergence = null;
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
        }
        else {
            report.steps.push(fullStep(step));
        }
    }
    const snapshot = decoder.snapshot();
    const cache = compareVectors(flattenCache(snapshot), flattenCache(full.cache));
    maxAbsoluteError = Math.max(maxAbsoluteError, cache.maxAbsoluteError);
    maxRelativeError = Math.max(maxRelativeError, cache.maxRelativeError);
    firstDivergence = resolveFirstDivergence(firstDivergence, cache.passes, validated.tokens.length);
    const passes = firstDivergence === null;
    const metadata = {
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
    const comparison = {
        passes,
        firstDivergence,
        stepsCompared: report.steps.length,
        maxAbsoluteError,
        maxRelativeError,
        cache,
    };
    const workSummary = {
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
export async function expandExperimentStep(input, position) {
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
export async function replayExperiment(report) {
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
