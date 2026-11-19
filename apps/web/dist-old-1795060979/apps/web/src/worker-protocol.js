import { LabError, validateInput } from '../../../packages/contracts/index.js';
function record(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new LabError('INPUT', 'invalid worker data record');
    }
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
            throw new LabError('INPUT', 'worker records must contain only data properties');
        }
    }
    return value;
}
export function workerMessageId(value) {
    try {
        const id = record(value).id;
        return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
    }
    catch {
        return null;
    }
}
export function parseWorkerRequest(value) {
    const data = record(value);
    const id = workerMessageId(data);
    if (id === null || data.kind !== 'run' || Object.keys(data).sort().join(',') !== 'id,input,kind') {
        throw new LabError('INPUT', 'invalid worker request');
    }
    return { kind: 'run', id, input: validateInput(data.input) };
}
function milliseconds(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function parseWorkerResponse(value) {
    const data = record(value);
    const id = workerMessageId(data);
    if (id === null)
        throw new LabError('INPUT', 'invalid worker response id');
    if (data.kind === 'error') {
        const error = record(data.error);
        if (typeof error.code !== 'string' || typeof error.message !== 'string') {
            throw new LabError('INPUT', 'invalid worker error');
        }
        return { kind: 'error', id, error: { code: error.code, message: error.message } };
    }
    if (data.kind !== 'result' || data.executionContext !== 'worker') {
        throw new LabError('INPUT', 'invalid worker response');
    }
    const timing = record(data.timing);
    if (!milliseconds(timing.fullForwardMs) || !milliseconds(timing.cachedDecoderMs)
        || !milliseconds(timing.totalMs)
        || timing.totalMs < timing.fullForwardMs + timing.cachedDecoderMs) {
        throw new LabError('INPUT', 'invalid worker timing');
    }
    // The same-origin worker owns numerical validation. Check the report envelope
    // here without recomputing any tensors on the UI thread.
    const result = record(data.result);
    const input = validateInput(result.input);
    if (result.schemaVersion !== 1 || result.mode !== 'numerical'
        || typeof result.engineVersion !== 'string' || 'timing' in result || 'detail' in result
        || !Array.isArray(result.steps) || result.steps.length !== input.tokens.length
        || !Array.isArray(result.finalCache)
        || typeof record(result.model).weightsSha256 !== 'string'
        || typeof record(result.comparison).passes !== 'boolean'
        || typeof record(result.workSummary).complexityClass !== 'string') {
        throw new LabError('INPUT', 'invalid worker result');
    }
    return { kind: 'result', id, result: data.result,
        timing: { fullForwardMs: timing.fullForwardMs, cachedDecoderMs: timing.cachedDecoderMs, totalMs: timing.totalMs },
        executionContext: 'worker' };
}
/** Never relay arbitrary exception text, input keys, stack traces or local paths. */
export function safeWorkerError(error) {
    if (error instanceof LabError) {
        switch (error.code) {
            case 'INPUT': return { code: 'INPUT', message: 'Invalid experiment input.' };
            case 'CONTEXT_LIMIT': return { code: 'CONTEXT_LIMIT', message: 'Experiment exceeds the context limit.' };
            case 'NON_FINITE': return { code: 'NON_FINITE', message: 'Experiment produced non-finite values.' };
            case 'OOM': return { code: 'OOM', message: 'Insufficient experiment capacity.' };
        }
    }
    return { code: 'INTERNAL', message: 'Worker computation failed.' };
}
