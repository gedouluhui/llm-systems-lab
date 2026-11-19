import { PagePool } from '../../../packages/simulator/index.js';
/**
 * Applies a recorded paging history to a fresh pool. The returned pool is the
 * state after the last operation; callers take a snapshot when they need a
 * view. Any invalid id, oversized append or exhausted pool throws and leaves
 * nothing partially allocated.
 */
export function replayPaging(pageSize, pageCount, operations) {
    const pool = new PagePool(pageSize, pageCount);
    for (const operation of operations) {
        if (operation.op === 'append') {
            pool.append(operation.id, operation.tokens);
        }
        else {
            pool.release(operation.id);
        }
    }
    return pool;
}
