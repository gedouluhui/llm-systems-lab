import { validateInput } from '../../../packages/contracts/index.js';
import type { ExperimentResult, ExperimentTiming } from '../../../packages/core/index.js';
import { parseWorkerResponse, workerMessageId } from './worker-protocol.js';
import type { WorkerRequest } from './worker-protocol.js';

export interface WorkerRunResult {
  result: ExperimentResult;
  timing: ExperimentTiming;
  roundTripMs: number;
  executionContext: 'worker';
}

export class WorkerClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkerClientError';
  }
}

/** One owned worker per request; no synchronous numerical fallback. */
export class ExperimentWorkerClient {
  private nextId = 0;
  private disposed = false;
  private active: { cancel: () => void } | null = null;

  cancel(): void {
    this.active?.cancel();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  async run(input: unknown): Promise<WorkerRunResult> {
    this.cancel();
    if (this.disposed) throw new WorkerClientError('DISPOSED', 'Worker client is disposed.');
    const validated = validateInput(input);
    const id = ++this.nextId;
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let worker: Worker | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (worker !== null) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
        }
        if (this.active === active) this.active = null;
      };
      const fail = (code: string, message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new WorkerClientError(code, message));
      };
      const active = { cancel: () => fail('CANCELLED', 'Request superseded or cancelled.') };
      this.active = active;
      try {
        worker = new Worker(new URL('./experiment-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<unknown>): void => {
          if (settled) return;
          const receivedId = workerMessageId(event.data);
          if (receivedId !== null && receivedId !== id) return;
          const roundTripMs = performance.now() - started;
          try {
            const response = parseWorkerResponse(event.data);
            if (response.kind === 'error') {
              fail('WORKER_COMPUTE', 'Worker computation failed. Check the input and try again.');
              return;
            }
            settled = true;
            cleanup();
            resolve({ result: response.result, timing: response.timing, roundTripMs,
              executionContext: response.executionContext });
          } catch {
            fail('WORKER_PROTOCOL', 'Worker returned an invalid response.');
          }
        };
        worker.onerror = (event): void => {
          event.preventDefault?.();
          fail('WORKER_RUNTIME', 'Worker could not load or execute.');
        };
        worker.onmessageerror = (): void => fail('WORKER_MESSAGE', 'Worker message could not be decoded.');
        timer = setTimeout(() => fail('WORKER_TIMEOUT', 'Worker exceeded the 30-second safety limit.'), 30000);
        const request: WorkerRequest = { kind: 'run', id, input: validated };
        worker.postMessage(request);
      } catch {
        fail('WORKER_START', 'Worker could not start or receive input.');
      }
    });
  }
}
