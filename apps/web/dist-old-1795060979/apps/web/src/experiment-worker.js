import { runTimedExperiment } from '../../../packages/core/index.js';
import { parseWorkerRequest, safeWorkerError, workerMessageId } from './worker-protocol.js';
// Structural scope avoids mixing conflicting DOM and WebWorker global libs.
const scope = globalThis;
if (typeof scope.DedicatedWorkerGlobalScope !== 'function'
    || !scope.DedicatedWorkerGlobalScope.prototype.isPrototypeOf(globalThis)
    || typeof document !== 'undefined') {
    throw new Error('Experiment entry requires a dedicated worker context.');
}
scope.addEventListener('message', (event) => {
    void (async () => {
        const id = workerMessageId(event.data);
        if (id === null)
            return; // No valid request id to correlate a reply with.
        try {
            const request = parseWorkerRequest(event.data);
            const { result, timing } = await runTimedExperiment(request.input);
            scope.postMessage({ kind: 'result', id, result, timing, executionContext: 'worker' });
        }
        catch (error) {
            scope.postMessage({ kind: 'error', id, error: safeWorkerError(error) });
        }
    })();
});
