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

export class PagePool {
  readonly pageSize: number;
  readonly pageCount: number;
  private readonly requests = new Map<string, RequestState>();
  private freePages: number[];

  constructor(pageSize: unknown, pageCount: unknown) {
    this.pageSize = validatePageSize(pageSize);
    this.pageCount = validatePageCount(pageCount);
    this.freePages = Array.from({ length: this.pageCount }, (_, index) => index);
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
    if (needed > this.freePages.length) {
      throw new LabError(
        'OOM',
        `request "${requestId}" needs ${needed} more page(s); ${this.freePages.length} free`,
      );
    }

    const taken = this.freePages.slice(0, needed);
    this.freePages = this.freePages.slice(needed);
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
    this.freePages = [...this.freePages, ...existing.pages].sort((left, right) => left - right);
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
      freePages: [...this.freePages],
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
