import { LabError, MODEL_SPEC, validateInput, validateTokens, } from '../../../packages/contracts/index.js';
import { replayPaging } from './paging-run.js';
export const DOCUMENT_KIND = 'llm-systems-lab.experiment';
export const MAX_DOCUMENT_BYTES = 262144;
export const MAX_PAGING_OPERATIONS = 1000;
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 64;
export const MIN_PAGE_COUNT = 1;
export const MAX_PAGE_COUNT = 64;
/**
 * Guards the live paging log. Callers check this before mutating the pool so
 * a rejected operation leaves both the pool and the log untouched. The
 * document parser allows exactly MAX_PAGING_OPERATIONS entries; the live log
 * uses the same ceiling.
 */
export function assertPagingOperationBudget(operationCount) {
    if (!Number.isInteger(operationCount) || operationCount < 0) {
        throw new LabError('INPUT', 'paging operation count must be a non-negative integer');
    }
    if (operationCount >= MAX_PAGING_OPERATIONS) {
        throw new LabError('INPUT', `paging operations must contain at most ${MAX_PAGING_OPERATIONS} entries`);
    }
}
const DOCUMENT_KEYS = ['schemaVersion', 'kind', 'input', 'paging'];
const PAGING_KEYS = ['pageSize', 'pageCount', 'operations'];
const APPEND_KEYS = ['op', 'id', 'tokens'];
const RELEASE_KEYS = ['op', 'id'];
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, expected, label) {
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
        throw new LabError('INPUT', `${label} must not contain symbol keys`);
    }
    for (const name of names) {
        if (!expected.includes(name)) {
            throw new LabError('INPUT', `unexpected ${label} key "${name}"`);
        }
    }
    for (const name of expected) {
        if (!names.includes(name)) {
            throw new LabError('INPUT', `missing ${label} key "${name}"`);
        }
    }
}
function readValue(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
        throw new LabError('INPUT', `document field "${key}" must be a data property`);
    }
    return descriptor.value;
}
function checkInteger(value, min, max, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new LabError('INPUT', `${label} must be an integer in [${min}, ${max}]`);
    }
    return value;
}
function readPaging(value) {
    if (!isPlainRecord(value)) {
        throw new LabError('INPUT', 'paging must be a plain object');
    }
    exactKeys(value, PAGING_KEYS, 'paging');
    const pageSize = checkInteger(readValue(value, 'pageSize'), MIN_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize');
    const pageCount = checkInteger(readValue(value, 'pageCount'), MIN_PAGE_COUNT, MAX_PAGE_COUNT, 'pageCount');
    const raw = readValue(value, 'operations');
    if (!Array.isArray(raw)) {
        throw new LabError('INPUT', 'paging operations must be an array');
    }
    if (raw.length > MAX_PAGING_OPERATIONS) {
        throw new LabError('INPUT', `paging operations must contain at most ${MAX_PAGING_OPERATIONS} entries`);
    }
    const operations = [];
    for (let index = 0; index < raw.length; index += 1) {
        const entry = raw[index];
        if (!isPlainRecord(entry)) {
            throw new LabError('INPUT', `paging operation ${index} must be a plain object`);
        }
        const op = readValue(entry, 'op');
        if (op === 'append') {
            exactKeys(entry, APPEND_KEYS, `append operation ${index}`);
            const id = readValue(entry, 'id');
            if (typeof id !== 'string') {
                throw new LabError('INPUT', `append operation ${index} id must be a string`);
            }
            const tokens = readValue(entry, 'tokens');
            if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 1) {
                throw new LabError('INPUT', `append operation ${index} tokens must be a positive integer`);
            }
            operations.push({ op: 'append', id, tokens });
        }
        else if (op === 'release') {
            exactKeys(entry, RELEASE_KEYS, `release operation ${index}`);
            const id = readValue(entry, 'id');
            if (typeof id !== 'string') {
                throw new LabError('INPUT', `release operation ${index} id must be a string`);
            }
            operations.push({ op: 'release', id });
        }
        else {
            throw new LabError('INPUT', `paging operation ${index} has an unknown op`);
        }
    }
    return { pageSize, pageCount, operations };
}
export function parseTokens(text) {
    if (typeof text !== 'string') {
        throw new LabError('INPUT', 'token input must be text');
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        throw new LabError('INPUT', 'tokens must not be empty');
    }
    if (!/^\d+(?:(?:\s*,\s*|\s+)\d+)*$/.test(trimmed)) {
        throw new LabError('INPUT', 'tokens must be base-10 integers separated by commas or whitespace');
    }
    const tokens = trimmed.split(/[\s,]+/).map((part) => Number(part));
    return validateTokens(tokens);
}
export function summarizeRun(result) {
    const work = result.workSummary;
    return {
        passes: result.comparison.passes,
        firstDivergence: result.comparison.firstDivergence,
        stepsCompared: result.comparison.stepsCompared,
        maxAbsoluteError: result.comparison.maxAbsoluteError,
        maxRelativeError: result.comparison.maxRelativeError,
        fingerprintShort: shortHash(result.model.weightsSha256),
        engineVersion: result.engineVersion,
        totalRecomputeTokens: work.totalRecomputeTokens,
        expectedCachedTokens: work.expectedCachedTokens,
        totalKvReadSlots: work.totalKvReadSlots,
        totalAttentionMacs: work.totalAttentionMacs,
        complexityClass: work.complexityClass,
        degraded: work.totalRecomputeTokens > work.expectedCachedTokens,
    };
}
export function buildCapture(result) {
    return result.steps.map((step) => {
        const marks = [];
        const seenWrites = new Set();
        const seenOverwrites = new Set();
        for (const event of step.cacheEvents) {
            const writeKey = `${event.layer}:${event.writeSlot}`;
            if (!seenWrites.has(writeKey)) {
                seenWrites.add(writeKey);
                marks.push({ kind: 'write', layer: event.layer, slot: event.writeSlot });
            }
            for (const slot of event.readSlots) {
                marks.push({ kind: 'read', layer: event.layer, slot });
            }
            if (event.overwrittenSlot !== null) {
                const overwriteKey = `${event.layer}:${event.overwrittenSlot}`;
                if (!seenOverwrites.has(overwriteKey)) {
                    seenOverwrites.add(overwriteKey);
                    marks.push({ kind: 'overwrite', layer: event.layer, slot: event.overwrittenSlot });
                }
            }
        }
        return {
            position: step.position,
            token: step.token,
            diverged: result.comparison.firstDivergence === step.position,
            marks,
        };
    });
}
export function buildStepRows(result) {
    return result.steps.map((step) => {
        let maxAbs = step.logits.maxAbsoluteError;
        let maxRel = step.logits.maxRelativeError;
        let passes = step.logits.passes;
        for (const layer of step.hidden) {
            maxAbs = Math.max(maxAbs, layer.comparison.maxAbsoluteError);
            maxRel = Math.max(maxRel, layer.comparison.maxRelativeError);
            passes = passes && layer.comparison.passes;
        }
        return {
            position: step.position,
            token: step.token,
            passes,
            maxAbs,
            maxRel,
            cacheEvents: step.cacheEvents.map((event) => ({
                layer: event.layer,
                writeSlot: event.writeSlot,
                readSlots: [...event.readSlots],
                overwrittenSlot: event.overwrittenSlot,
            })),
        };
    });
}
export function buildCacheSlots(result) {
    const slotCount = result.input.tokens.length;
    const layers = Array.from({ length: MODEL_SPEC.numLayers }, (_, layer) => (Array.from({ length: slotCount }, (_, slot) => ({
        layer,
        slot,
        written: false,
        readCount: 0,
        overwritten: false,
    }))));
    for (const step of result.steps) {
        for (const event of step.cacheEvents) {
            const row = layers[event.layer];
            if (row === undefined) {
                continue;
            }
            const write = row[event.writeSlot];
            if (write !== undefined) {
                write.written = true;
            }
            for (const slot of event.readSlots) {
                const read = row[slot];
                if (read !== undefined) {
                    read.readCount += 1;
                }
            }
            if (event.overwrittenSlot !== null) {
                const overwritten = row[event.overwrittenSlot];
                if (overwritten !== undefined) {
                    overwritten.overwritten = true;
                }
            }
        }
    }
    return layers;
}
export function pagingView(snapshot) {
    const owners = new Map();
    for (const request of snapshot.requests) {
        for (const page of request.pages) {
            owners.set(page, request.id);
        }
    }
    const cells = Array.from({ length: snapshot.pageCount }, (_, page) => ({
        page,
        owner: owners.get(page) ?? null,
    }));
    return {
        cells,
        usedPages: snapshot.allocatedPages,
        freePages: snapshot.freePages.length,
        logicalBytes: snapshot.logicalBytes,
        allocatedBytes: snapshot.allocatedBytes,
        wasteBytes: snapshot.wasteBytes,
        capacityBytes: snapshot.capacityBytes,
    };
}
export function buildExperimentDocument(input, paging) {
    return {
        schemaVersion: 1,
        kind: DOCUMENT_KIND,
        input: {
            schemaVersion: 1,
            seed: input.seed,
            tokens: [...input.tokens],
            fault: input.fault,
        },
        paging: {
            pageSize: paging.pageSize,
            pageCount: paging.pageCount,
            operations: paging.operations.map((operation) => ({ ...operation })),
        },
    };
}
export function parseExperimentDocument(text, maxBytes = MAX_DOCUMENT_BYTES) {
    if (typeof text !== 'string') {
        throw new LabError('INPUT', 'experiment document must be text');
    }
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > maxBytes) {
        throw new LabError('INPUT', `experiment document must be at most ${maxBytes} bytes`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new LabError('INPUT', 'experiment document must be valid JSON');
    }
    if (!isPlainRecord(parsed)) {
        throw new LabError('INPUT', 'experiment document must be a plain object');
    }
    exactKeys(parsed, DOCUMENT_KEYS, 'experiment document');
    if (readValue(parsed, 'schemaVersion') !== 1) {
        throw new LabError('INPUT', 'schemaVersion must be exactly 1');
    }
    if (readValue(parsed, 'kind') !== DOCUMENT_KIND) {
        throw new LabError('INPUT', `kind must be "${DOCUMENT_KIND}"`);
    }
    const input = validateInput(readValue(parsed, 'input'));
    const paging = readPaging(readValue(parsed, 'paging'));
    replayPaging(paging.pageSize, paging.pageCount, paging.operations);
    return { schemaVersion: 1, kind: DOCUMENT_KIND, input, paging };
}
export function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
        throw new LabError('INPUT', 'byte count must be a finite non-negative number');
    }
    if (bytes < 1024) {
        return `${new Intl.NumberFormat('en-US').format(bytes)} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function formatNumber(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return 'NaN';
    }
    if (value === Infinity) {
        return '∞';
    }
    if (value === -Infinity) {
        return '−∞';
    }
    if (value === 0) {
        return '0';
    }
    const magnitude = Math.abs(value);
    if (magnitude < 1e-3 || magnitude >= 1e5) {
        return value.toExponential(3);
    }
    return Number(value.toPrecision(6)).toString();
}
export function shortHash(hash) {
    if (typeof hash !== 'string' || hash.length === 0) {
        throw new LabError('INPUT', 'hash must be a non-empty string');
    }
    return `${hash.slice(0, 12)}…`;
}
function isLabErrorLike(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value;
    return candidate.name === 'LabError'
        && typeof candidate.code === 'string'
        && typeof candidate.message === 'string';
}
export function formatError(error) {
    if (isLabErrorLike(error)) {
        return `${error.code}: ${error.message}`;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return 'Unexpected error';
}
export { replayPaging };
