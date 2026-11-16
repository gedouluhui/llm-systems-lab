import { LabError } from '../contracts/index.js';

/**
 * Theoretical KV payload per token for tiny-decoder-v1:
 * 2 (K and V) * 2 layers * 2 KV heads * 8 head dimensions * 4 bytes.
 * This is a teaching accounting unit, not process RSS or measured VRAM.
 */
const BYTES_PER_TOKEN = 2 * 2 * 2 * 8 * 4;
const MAX_PAGES = 1024;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOCATION_POLICIES = ['lowest', 'stack'] as const;

export type PageAllocationPolicy = (typeof ALLOCATION_POLICIES)[number];

export interface PageAssignment {
  id: string;
  tokens: number;
  pages: number[];
  allocatedTokens: number;
  allocatedBytes: number;
  logicalBytes: number;
}

export interface PagePoolSnapshot {
  pageSize: number;
  pageCount: number;
  allocationPolicy: PageAllocationPolicy;
  bytesPerToken: number;
  capacityTokens: number;
  capacityBytes: number;
  logicalTokens: number;
  logicalBytes: number;
  allocatedPages: number;
  allocatedTokens: number;
  allocatedBytes: number;
  wasteTokens: number;
  wasteBytes: number;
  freePages: number[];
  requests: PageAssignment[];
}

export interface ReleaseSummary {
  id: string;
  releasedPages: number[];
  releasedTokens: number;
}

interface RequestState {
  tokens: number;
  pages: number[];
}

function validatePageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < MIN_PAGE_SIZE || value > MAX_PAGE_SIZE) {
    throw new LabError(
      'INPUT',
      `pageSize must be an integer in [${MIN_PAGE_SIZE}, ${MAX_PAGE_SIZE}]`,
    );
  }
  return value;
}

function validatePageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGES) {
    throw new LabError('INPUT', `pageCount must be an integer in [1, ${MAX_PAGES}]`);
  }
  return value;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new LabError('INPUT', 'request id must be 1..64 characters of [A-Za-z0-9_-]');
  }
  return value;
}

function validateAllocationPolicy(value: unknown): PageAllocationPolicy {
  if (typeof value !== 'string' || !(ALLOCATION_POLICIES as readonly string[]).includes(value)) {
    throw new LabError('INPUT', 'allocationPolicy must be "lowest" or "stack"');
  }
  return value as PageAllocationPolicy;
}

/**
 * Free-page store with a selectable allocation policy.
 *
 * - `lowest` is a binary min-heap: taking or returning one page costs
 *   O(log P), and the next append always receives the lowest free page
 *   number, which is what the original slice-based array did.
 * - `stack` is a LIFO array: both ends are O(1), so the most recently
 *   released page is the first one reused.
 *
 * `snapshot()` always lists free page numbers ascending; the policy only
 * decides which of those pages the next append takes.
 */
class FreePageStore {
  readonly policy: PageAllocationPolicy;
  private readonly heap: number[] = [];
  private readonly stack: number[] = [];

  constructor(policy: PageAllocationPolicy, pageCount: number) {
    this.policy = policy;
    if (policy === 'lowest') {
      // [0, 1, ..., P-1] already satisfies the min-heap order property.
      for (let page = 0; page < pageCount; page += 1) this.heap.push(page);
    } else {
      // Descending insertion makes the first pops climb 0, 1, 2, ... so the
      // stack starts out identical to `lowest` until a release happens.
      for (let page = pageCount - 1; page >= 0; page -= 1) this.stack.push(page);
    }
  }

  get size(): number {
    return this.policy === 'lowest' ? this.heap.length : this.stack.length;
  }

  take(count: number): number[] {
    const taken: number[] = [];
    for (let index = 0; index < count; index += 1) {
      taken.push(this.policy === 'lowest' ? this.popHeap() : this.stack.pop()!);
    }
    return taken;
  }

  give(pages: readonly number[]): void {
    for (const page of pages) {
      if (this.policy === 'lowest') {
        this.pushHeap(page);
      } else {
        this.stack.push(page);
      }
    }
  }

  sorted(): number[] {
    const source = this.policy === 'lowest' ? this.heap : this.stack;
    return [...source].sort((left, right) => left - right);
  }

  private popHeap(): number {
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.heap.length && this.heap[left]! < this.heap[smallest]!) smallest = left;
        if (right < this.heap.length && this.heap[right]! < this.heap[smallest]!) smallest = right;
        if (smallest === index) break;
        const swap = this.heap[index]!;
        this.heap[index] = this.heap[smallest]!;
        this.heap[smallest] = swap;
        index = smallest;
      }
    }
    return top;
  }

  private pushHeap(page: number): void {
    this.heap.push(page);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[parent]! <= this.heap[index]!) break;
      const swap = this.heap[index]!;
      this.heap[index] = this.heap[parent]!;
      this.heap[parent] = swap;
      index = parent;
    }
  }
}

export class PagePool {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly allocationPolicy: PageAllocationPolicy;
  private readonly requests = new Map<string, RequestState>();
  private readonly freePages: FreePageStore;

  constructor(pageSize: unknown, pageCount: unknown, allocationPolicy: unknown = 'lowest') {
    this.pageSize = validatePageSize(pageSize);
    this.pageCount = validatePageCount(pageCount);
    this.allocationPolicy = validateAllocationPolicy(allocationPolicy);
    this.freePages = new FreePageStore(this.allocationPolicy, this.pageCount);
  }

  get capacityTokens(): number {
    return this.pageSize * this.pageCount;
  }

  append(id: unknown, count: unknown): PageAssignment {
    const requestId = validateRequestId(id);
    if (typeof count !== 'number' || !Number.isInteger(count)
      || count < 1 || count > this.capacityTokens) {
      throw new LabError(
        'INPUT',
        `append count must be a positive integer of at most ${this.capacityTokens}`,
      );
    }

    const existing = this.requests.get(requestId);
    const tokens = (existing === undefined ? 0 : existing.tokens) + count;
    const allocatedPages = existing === undefined ? 0 : existing.pages.length;
    const needed = Math.ceil(tokens / this.pageSize) - allocatedPages;
    if (needed > this.freePages.size) {
      throw new LabError(
        'OOM',
        `request "${requestId}" needs ${needed} more page(s); ${this.freePages.size} free`,
      );
    }

    const taken = this.freePages.take(needed);
    if (existing === undefined) {
      this.requests.set(requestId, { tokens, pages: taken });
    } else {
      existing.tokens = tokens;
      existing.pages.push(...taken);
    }
    return this.describe(requestId);
  }

  release(id: unknown): ReleaseSummary {
    const requestId = validateRequestId(id);
    const existing = this.requests.get(requestId);
    if (existing === undefined) {
      throw new LabError('INPUT', `unknown request "${requestId}"`);
    }
    this.requests.delete(requestId);
    this.freePages.give(existing.pages);
    return {
      id: requestId,
      releasedPages: [...existing.pages].sort((left, right) => left - right),
      releasedTokens: existing.tokens,
    };
  }

  snapshot(): PagePoolSnapshot {
    const requests = Array.from(this.requests.keys(), (id) => this.describe(id));
    let logicalTokens = 0;
    let allocatedPages = 0;
    for (const request of requests) {
      logicalTokens += request.tokens;
      allocatedPages += request.pages.length;
    }
    const allocatedTokens = allocatedPages * this.pageSize;
    const wasteTokens = allocatedTokens - logicalTokens;
    return {
      pageSize: this.pageSize,
      pageCount: this.pageCount,
      allocationPolicy: this.allocationPolicy,
      bytesPerToken: BYTES_PER_TOKEN,
      capacityTokens: this.capacityTokens,
      capacityBytes: this.capacityTokens * BYTES_PER_TOKEN,
      logicalTokens,
      logicalBytes: logicalTokens * BYTES_PER_TOKEN,
      allocatedPages,
      allocatedTokens,
      allocatedBytes: allocatedTokens * BYTES_PER_TOKEN,
      wasteTokens,
      wasteBytes: wasteTokens * BYTES_PER_TOKEN,
      freePages: this.freePages.sorted(),
      requests,
    };
  }

  private describe(id: string): PageAssignment {
    const entry = this.requests.get(id)!;
    const allocatedTokens = entry.pages.length * this.pageSize;
    return {
      id,
      tokens: entry.tokens,
      pages: [...entry.pages],
      allocatedTokens,
      allocatedBytes: allocatedTokens * BYTES_PER_TOKEN,
      logicalBytes: entry.tokens * BYTES_PER_TOKEN,
    };
  }
}
