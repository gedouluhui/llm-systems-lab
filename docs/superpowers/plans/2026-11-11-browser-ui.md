# Browser UI (A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a static, dependency-free browser lab that lets a first-time visitor run the frozen tiny decoder, see cached and full-prefix results agree, inject each teaching fault to find the first divergence, inspect KV cache reads/writes, and run a single-request paging experiment — with keyboard, bilingual, narrow-screen and reduced-motion support, and reproducible browser evidence.

**Architecture:** A vanilla TypeScript single-page app compiled to native ES modules under `apps/web/dist`, served by a fixed-root static server for local development and deployable to any static host. All numerical answers come from the existing `packages/core` and `packages/simulator`; the UI only validates input, calls those modules, and renders their output. A dependency-free CDP harness drives an isolated headless Edge/Chrome for end-to-end evidence.

**Tech Stack:** TypeScript 5.9.3 (already installed), native DOM/ES modules, CSS custom properties, Node 26 built-in test runner, Node global `fetch`/`WebSocket` for CDP. No React, Vite, runtime dependencies, web fonts, CDNs, analytics or external APIs.

**Spec:** the project handover (internal, not part of this repository) §5.4–5.8 and §6 (A-UI-1, A-UI-2, A-REP-1, A-SEC-1); `docs/NUMERICAL_CONTRACT.md`.

> **Historical note:** this plan was executed before the first public release. The "no commits, no publication" constraint below described that phase only and no longer applies to the repository.

## Global Constraints

- **No Git commits, no publication.** The A1 tree is still uncommitted and the user has not requested commits; every task ends with verification files, not a commit.
- **No external dependencies or network assets.** No React/Vite, no web fonts, no CDN, no analytics, no model API. Everything needed after first load is in `apps/web/dist`.
- **Single source of numerical truth.** The UI must call `runExperiment` and `PagePool`; it must never recompute logits, cache state or page accounting for display.
- **No measured-data claims.** Every result is labelled `NUMERICAL` or `SIMULATION`. Never label UI compute time as GPU latency or paging bytes as VRAM.
- **Input limits:** tokens 1–64 integers in `[0,31]`; seed integer in `[0,4294967295]`; imported document ≤ 256 KiB (`262144` bytes); paging operations ≤ 1000; UI page size 1–64; UI page count 1–64 (the core still supports 1024).
- **XSS:** render user-controlled strings with `textContent` or DOM properties only; never `innerHTML` with data; no `eval`, `new Function`, dynamic script, or external URL from imported data. CSP meta tag and response header are required.
- **Accessibility:** native form controls with labels; one `h1`; landmarks; `aria-live="polite"` run status; visible `:focus-visible`; no positive `tabindex`; keyboard can reach and activate every control; `prefers-reduced-motion` removes animation; no horizontal overflow at 360 px and 640 px CSS width.
- **Performance:** a 64-token experiment must complete and render in under 200 ms on this machine; core measurement is ~5 ms, so start synchronous and only add a Worker if the E2E budget fails.
- **Asset budget:** `apps/web/dist` total bytes ≤ 2 MiB (`2097152`).
- **A1 stays green:** the existing 71 TypeScript tests, 18 Python tests, 130-case fixture and 6 mutants must continue to pass.
- **Windows commands:** invoke `node` directly. Do not assume `npm` is on `PATH`; `scripts/build-web.mjs` resolves `node_modules/typescript/bin/tsc` by absolute path.
- **Browser safety:** the E2E harness launches its own headless browser with a fresh temporary `--user-data-dir`; it never touches the user profile and terminates only the child PID it started.

## Rulings

- **Vanilla TypeScript instead of React/Vite.** The handover calls TypeScript + Vite + React a preference, not a requirement; this machine has neither installed and the no-external-dependency rule rules out fetching them. The page is one screen with native controls, so a framework adds risk without benefit. Cost if wrong: a later component-heavy extension may need a migration; the DOM contract and view model are framework-independent.
- **One bilingual page, English chrome, Chinese explanations always visible.** A language toggle switches chrome; each route keeps an English explanation and a Chinese explanation side by side. Cost if wrong: more vertical space; it is the point of the teaching page.
- **Separate `apps/web/dist`, not part of the npm tarball.** The packed CLI stays runtime-only. Cost if wrong: a later npm-hosted demo must add `files` entries and a new pack test.
- **Browser E2E is a separate gate.** `scripts/verify.mjs` adds web build and web unit tests (8 stages); `node scripts/e2e-web.mjs` is required for A2 acceptance but not for the npm CLI gate, because browser availability differs across machines. Both receipts must be pasted into the handover.

---

## Design Direction (locked before coding)

**Subject:** a lab bench for a tiny decoder; the visitor is looking at a logic-analyzer capture of cache traffic, not a marketing dashboard.

**Palette (CSS custom properties):**

| Token | Value | Use |
|---|---|---|
| `--paper` | `#E9EDEB` | page background |
| `--surface` | `#F8FAF9` | panels and tables |
| `--ink` | `#0E1F1D` | primary text and rules |
| `--muted` | `#4B615D` | secondary text |
| `--rule` | `#A7B6B1` | 1 px dividers and grid |
| `--signal` | `#00636B` | read marks, links, primary action |
| `--amber` | `#9A5B00` | write marks and selected step |
| `--fault` | `#A11D33` | divergent step and fault labels |
| `--ok` | `#245C43` | pass status |

**Type:** `--font-ui: "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif`; `--font-data: "Cascadia Mono", Consolas, "SFMono-Regular", ui-monospace, monospace`. No `@font-face`. Headings are uppercase, condensed, letter-spaced; all numbers use the data face with tabular figures.

**Layout:** masthead strip; below 960 px a single column, at and above it a 320 px control rail plus a flexible instrument column. Panels are square-cornered (2 px) with 1 px rules, no shadows, no gradients, no glass or glow.

**Signature:** the **capture bar** — one narrow column per token position, each showing two layer lanes of write/read marks, a fault caret at the first divergence, and a movable amber cursor for the selected step. It is the first thing under the masthead and is built from real `cacheEvents`, not decoration.

**Motion:** only the status lamp pulses while a run is in progress (1.2 s); `prefers-reduced-motion: reduce` sets it to none. No scroll reveals, parallax or decorative transitions.

---

## File Structure

```text
apps/web/static/index.html        static shell: masthead, main landmarks, CSP, module entry
apps/web/static/styles.css        design tokens, layout, components, responsive + reduced motion
apps/web/src/i18n.ts              typed EN/ZH copy, placeholder formatting
apps/web/src/view-model.ts        pure adapters: parse tokens, summaries, capture, cache, paging, export/import
apps/web/src/paging-run.ts        replay paging operations against a fresh PagePool
apps/web/src/main.ts              DOM wiring, state, render functions, window.__lab test surface
scripts/build-web.mjs             clean, compile with tsc -p tsconfig.web.json, copy static, validate budget
scripts/serve-web.mjs             fixed-root static server with path safety and security headers
scripts/e2e-web.mjs               dependency-free CDP harness: server + headless browser + assertions + screenshots
tsconfig.web.json                  DOM build for packages/** and apps/web/src/**
tests/web-build.test.mjs           build output, budget, CSP, no external references
tests/serve-web.test.mjs           path traversal, methods, MIME, headers
tests/web-view-model.test.mjs      summary/capture/cache/paging/export-import/token parsing
tests/web-i18n.test.mjs            key parity and placeholder formatting
tests/e2e-harness.test.mjs         pure helpers: DevTools port parsing, local-origin check, CDP message framing
```

`apps/web/dist/` is generated and stays out of Git; do not edit it by hand.

---

### Task 1: Web build pipeline and safe static server

**Files:**
- Create: `tsconfig.web.json`
- Create: `apps/web/static/index.html`
- Create: `apps/web/static/styles.css`
- Create: `apps/web/src/main.ts`
- Create: `scripts/build-web.mjs`
- Create: `scripts/serve-web.mjs`
- Test: `tests/web-build.test.mjs`
- Test: `tests/serve-web.test.mjs`
- Modify: `package.json` (scripts), `.gitignore` (`apps/web/dist/`)

**Interfaces:**
- Produces: `buildWeb(): { totalBytes: number; files: string[] }` from `scripts/build-web.mjs`, plus CLI behavior when run directly.
- Produces: `resolveRequestPath(root: string, requestPath: string): string | null` and `createStaticServer(root: string): http.Server` from `scripts/serve-web.mjs`.
- Produces: `WEB_MAX_BYTES = 2 * 1024 * 1024`.

- [ ] **Step 1: Write the failing build test**

```js
// tests/web-build.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildWeb, WEB_MAX_BYTES } from '../scripts/build-web.mjs';

const root = process.cwd();
const dist = join(root, 'apps', 'web', 'dist');

test('buildWeb produces a self-contained static bundle under the budget', () => {
  const result = buildWeb();
  assert.ok(existsSync(join(dist, 'index.html')));
  assert.ok(existsSync(join(dist, 'styles.css')));
  assert.ok(existsSync(join(dist, 'apps', 'web', 'src', 'main.js')));
  assert.ok(result.totalBytes > 0 && result.totalBytes <= WEB_MAX_BYTES);

  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /type="module"/);
  assert.match(html, /src="\.\/apps\/web\/src\/main\.js"/);
  assert.equal(/https?:\/\//.test(html), false, 'no external URLs in HTML');
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'no inline scripts');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/web-build.test.mjs`
Expected: FAIL because `scripts/build-web.mjs` does not exist.

- [ ] **Step 3: Implement the build script and shell**

`scripts/build-web.mjs` must:

1. Resolve `typescript/bin/tsc` from `node_modules` by absolute path, failing closed with a clear message.
2. Delete `apps/web/dist`, run `process.execPath` with `[tsc, '-p', 'tsconfig.web.json']` and `cwd` at the repo root; any non-zero exit throws.
3. Copy `apps/web/static/index.html` and `apps/web/static/styles.css` into `apps/web/dist`.
4. Walk `apps/web/dist`, reject any file outside the allowed extensions (`.html`, `.css`, `.js`, `.d.ts`, `.map`, `.svg`, `.json`), reject total bytes over `WEB_MAX_BYTES`, and return `{ totalBytes, files }`.
5. Export `buildWeb`; when `import.meta.url === pathToFileURL(process.argv[1]).href`, run it and print `web build: N files, M bytes`.

`tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": false,
    "noEmitOnError": true,
    "rootDir": ".",
    "outDir": "apps/web/dist",
    "forceConsistentCasingInFileNames": true
  },
  "include": ["packages/**/*.ts", "apps/web/src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests", "artifacts", "reference", ".superpowers"]
}
```

`apps/web/static/index.html` shell must include the CSP meta tag, a skip link, `<header class="masthead">`, `<main id="main">`, `<p id="boot-status">Loading lab…</p>`, and the module script `./apps/web/src/main.js`. `apps/web/src/main.ts` for this task only sets `document.documentElement.dataset.ready = 'true'` and `window.__lab = { ready: true, runCount: 0, lastRunMs: 0 }` (declare the global interface).

- [ ] **Step 4: Write the failing server test**

```js
// tests/serve-web.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer, resolveRequestPath } from '../scripts/serve-web.mjs';

test('resolveRequestPath serves only files under the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-root-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'sub', 'app.js'), 'export {};');
  assert.equal(resolveRequestPath(root, '/'), join(root, 'index.html'));
  assert.equal(resolveRequestPath(root, '/sub/app.js'), join(root, 'sub', 'app.js'));
  for (const bad of ['/../secret', '/%2e%2e/secret', '/sub/..%2f..%2fsecret', '/C:/Windows/win.ini', '/nul\u0000']) {
    assert.equal(resolveRequestPath(root, bad), null, bad);
  }
  assert.equal(resolveRequestPath(root, '/missing.js'), null);
});

test('server sets security headers and rejects non-read methods', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-root-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>lab</title>');
  const server = createStaticServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const missing = await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`);
    assert.equal(missing.status, 404);
    const post = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
```

- [ ] **Step 5: Run it, watch it fail, implement, rerun**

Run: `node --test tests/serve-web.test.mjs` → FAIL (module missing).

Implement `scripts/serve-web.mjs`:

- `resolveRequestPath`: decode with `decodeURIComponent` inside `try`; reject NUL, backslashes, absolute drive/UNC forms, and any `..` segment; resolve under root; require the result to start with `root + sep`; return `null` if not a file.
- `createStaticServer`: allow `GET`/`HEAD` only (otherwise 405), `Content-Type` map for `.html/.js/.css/.json/.svg/.ico`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- Direct CLI binds `127.0.0.1`, port `Number(process.env.PORT ?? 4173)`, prints the URL.

Run both tests again → PASS. Run `node scripts/build-web.mjs` → prints file count and bytes. Add package scripts:

```json
"build:web": "node scripts/build-web.mjs",
"serve:web": "node scripts/serve-web.mjs",
"test:web": "node --test tests/web-*.test.mjs"
```

Change `"test"` to `"npm run build && npm run build:web && node --test tests/"`. Add `apps/web/dist/` to `.gitignore`.

- [ ] **Step 6: Record evidence**

Save `node scripts/build-web.mjs` output and both test runs to `artifacts/a2/task1-build.log` and `artifacts/a2/task1-tests.log`.

---

### Task 2: Pure view model and typed bilingual copy

**Files:**
- Create: `apps/web/src/i18n.ts`
- Create: `apps/web/src/view-model.ts`
- Create: `apps/web/src/paging-run.ts`
- Test: `tests/web-view-model.test.mjs`
- Test: `tests/web-i18n.test.mjs`

**Interfaces (exact):**

```ts
export type Lang = 'en' | 'zh';

export interface RunSummary {
  passes: boolean;
  firstDivergence: number | null;
  stepsCompared: number;
  maxAbsoluteError: number;
  maxRelativeError: number;
  fingerprintShort: string;
  engineVersion: string;
}

export interface CaptureMark {
  kind: 'write' | 'read' | 'overwrite';
  layer: number;
  slot: number;
}

export interface CaptureColumn {
  position: number;
  token: number;
  diverged: boolean;
  marks: CaptureMark[];
}

export interface StepRow {
  position: number;
  token: number;
  passes: boolean;
  maxAbs: number;
  maxRel: number;
  cacheEvents: CacheEvent[];
}

export interface CacheSlot {
  layer: number;
  slot: number;
  written: boolean;
  readCount: number;
  overwritten: boolean;
}

export interface PagingCell { page: number; owner: string | null; }

export interface PagingView {
  cells: PagingCell[];
  usedPages: number;
  freePages: number;
  logicalBytes: number;
  allocatedBytes: number;
  wasteBytes: number;
  capacityBytes: number;
}

export type PagingOperation =
  | { op: 'append'; id: string; tokens: number }
  | { op: 'release'; id: string };

export interface ExperimentDocument {
  schemaVersion: 1;
  kind: 'llm-systems-lab.experiment';
  input: ExperimentInput;
  paging: { pageSize: number; pageCount: number; operations: PagingOperation[] };
}

export function parseTokens(text: string): number[];
export function summarizeRun(result: ExperimentResult): RunSummary;
export function buildCapture(result: ExperimentResult): CaptureColumn[];
export function buildStepRows(result: ExperimentResult): StepRow[];
export function buildCacheSlots(result: ExperimentResult): CacheSlot[][];
export function pagingView(snapshot: PagePoolSnapshot): PagingView;
export function buildExperimentDocument(input: ExperimentInput, paging: ExperimentDocument['paging']): ExperimentDocument;
export function parseExperimentDocument(text: string, maxBytes?: number): ExperimentDocument;
export function replayPaging(pageSize: number, pageCount: number, operations: PagingOperation[]): PagePool;
export function formatBytes(bytes: number): string;
export function formatNumber(value: number): string;
export function shortHash(hash: string): string;
export function formatError(error: unknown): string;
export function formatCopy(template: string, values: Record<string, string | number>): string;
export const COPY: Record<Lang, Copy>;
```

- [ ] **Step 1: Write failing view-model tests**

Use real core output, never hand-written logits:

```js
import { runExperiment } from '../dist/packages/core/index.js';
import { PagePool } from '../dist/packages/simulator/index.js';
import {
  parseTokens, summarizeRun, buildCapture, buildStepRows, buildCacheSlots,
  pagingView, buildExperimentDocument, parseExperimentDocument, replayPaging,
  formatBytes,
} from '../apps/web/dist/apps/web/src/view-model.js';

const base = { schemaVersion: 1, seed: 7, tokens: [1, 4, 2, 8, 3, 9], fault: 'none' };

test('summary reports the real comparison, never a hardcoded pass', async () => {
  const normal = await runExperiment(base);
  const summary = summarizeRun(normal);
  assert.equal(summary.passes, true);
  assert.equal(summary.firstDivergence, null);
  assert.equal(summary.stepsCompared, 6);
  assert.equal(summary.fingerprintShort, '75384d2cbebc…');
  assert.ok(Number.isFinite(summary.maxAbsoluteError));
});

test('a fault run exposes divergence at position 1 and overwrite marks', async () => {
  const fault = await runExperiment({ ...base, fault: 'cache-overwrite' });
  const summary = summarizeRun(fault);
  assert.equal(summary.passes, false);
  assert.equal(summary.firstDivergence, 1);
  const capture = buildCapture(fault);
  assert.equal(capture.length, 6);
  assert.equal(capture[0].diverged, false);
  assert.equal(capture[1].diverged, true);
  assert.ok(capture[1].marks.some((mark) => mark.kind === 'overwrite' && mark.slot === 0));
  const slots = buildCacheSlots(fault);
  assert.equal(slots.length, 2);
  assert.ok(slots[0][0].overwritten);
});

test('step rows mirror every per-position comparison', async () => {
  const normal = await runExperiment(base);
  const rows = buildStepRows(normal);
  assert.deepEqual(rows.map((row) => row.position), [0, 1, 2, 3, 4, 5]);
  assert.ok(rows.every((row) => row.passes === true));
});

test('paging view maps owners, waste and capacity from the simulator snapshot', () => {
  const pool = new PagePool(16, 4);
  pool.append('a', 32);
  pool.append('a', 1);
  const view = pagingView(pool.snapshot());
  assert.equal(view.cells.length, 4);
  assert.deepEqual(view.cells.map((cell) => cell.owner), ['a', 'a', 'a', null]);
  assert.equal(view.usedPages, 3);
  assert.equal(view.freePages, 1);
  assert.equal(view.logicalBytes, 8448);
  assert.equal(view.allocatedBytes, 12288);
  assert.equal(view.wasteBytes, 3840);
});

test('parseTokens accepts separators and rejects malformed or out-of-range input', () => {
  assert.deepEqual(parseTokens('1, 4 2\n8'), [1, 4, 2, 8]);
  assert.deepEqual(parseTokens('1 2 3'), [1, 2, 3]);
  for (const bad of ['', '1,,2', '1, ,2', '1.5', '32', '-1', '1;2']) {
    assert.throws(() => parseTokens(bad), /token|integer|array|empty/i, bad);
  }
  assert.throws(() => parseTokens(Array.from({ length: 65 }, () => 1).join(',')), /64/);
});

test('document round-trip validates and replays paging', () => {
  const operations = [
    { op: 'append', id: 'a', tokens: 32 },
    { op: 'append', id: 'a', tokens: 1 },
    { op: 'release', id: 'a' },
  ];
  const doc = buildExperimentDocument(base, { pageSize: 16, pageCount: 4, operations });
  const parsed = parseExperimentDocument(JSON.stringify(doc));
  assert.deepEqual(parsed, doc);
  const restored = replayPaging(16, 4, operations);
  assert.equal(restored.snapshot().requests.length, 0);
});

test('document parsing rejects unknown versions, unknown keys, oversize and bad ops', () => {
  const doc = buildExperimentDocument(base, { pageSize: 16, pageCount: 4, operations: [] });
  assert.throws(() => parseExperimentDocument(JSON.stringify({ ...doc, schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => parseExperimentDocument(JSON.stringify({ ...doc, extra: true })), /unexpected/i);
  assert.throws(() => parseExperimentDocument('x'.repeat(262145)), /262144/);
  assert.throws(() => parseExperimentDocument(JSON.stringify({
    ...doc, paging: { ...doc.paging, operations: [{ op: 'append', id: '../x', tokens: 1 }] },
  })), /request id/i);
  assert.throws(() => replayPaging(16, 1, [{ op: 'append', id: 'a', tokens: 17 }]), /OOM/);
});

test('formatBytes uses exact bytes below 1 KiB and one decimal above', () => {
  assert.equal(formatBytes(8192), '8,192 B');
  assert.equal(formatBytes(12288), '12.0 KiB');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test tests/web-view-model.test.mjs`
Expected: FAIL because `apps/web/dist/apps/web/src/view-model.js` is missing (run `node scripts/build-web.mjs` first so the failure is a missing export, not a missing directory).

- [ ] **Step 3: Implement the pure modules**

Rules:

- `parseTokens` splits on `/[\s,]+/`, trims, rejects empty fragments (including a trailing comma by rejecting an empty token between separators), parses base-10 integers, then delegates range/context checks to `validateTokens` from `packages/contracts`.
- `summarizeRun` copies fields from `result.comparison`; `fingerprintShort = shortHash(result.model.weightsSha256)`.
- `buildCapture` walks `result.steps`; for every `cacheEvent`, add a `write` mark, one `read` mark per `readSlots` entry, and an `overwrite` mark when `overwrittenSlot !== null`; `diverged` is `result.comparison.firstDivergence === position`. Deduplicate only repeated `write`/`overwrite` marks per layer/slot; keep every read mark so the read count is not understated.
- `buildStepRows` uses each step's `logits.passes` and the max of logits and hidden comparisons for `maxAbs`/`maxRel`.
- `buildCacheSlots` emits `MODEL_SPEC.numLayers` arrays of `result.input.tokens.length` slots; `written` when any write targets the slot, `readCount` counts read marks, `overwritten` when any event reports it.
- `pagingView` builds cells for every page; owner is the request whose `pages` contains it; totals come only from the snapshot.
- `buildExperimentDocument` returns exactly the four top-level keys and deep-copies input and operations.
- `parseExperimentDocument`: measure UTF-8 bytes with `TextEncoder`; reject over `maxBytes` with the exact limit in the message; `JSON.parse` in `try`; require a plain object with exactly `schemaVersion`, `kind`, `input`, `paging`; require `schemaVersion === 1` and `kind === 'llm-systems-lab.experiment'`; call `validateInput`; structural-check paging (`pageSize` 1–64 integer, `pageCount` 1–64 integer, operations array ≤ 1000, each op exactly `append{id,tokens}` or `release{id}`); then call `replayPaging` so invalid/OOM histories are rejected before returning a normalized doc. No fields from the document are trusted as results.
- `paging-run.ts` creates a fresh `PagePool`, applies operations in order, and returns the pool itself (callers read `pool.snapshot()` when they need a view).
- `formatBytes`: `Intl.NumberFormat('en-US')` for exact bytes `< 1024`; above, one decimal + ` KiB` for `< 1 MiB`, one decimal + ` MiB` otherwise.
- `formatNumber`: up to six significant digits with exponent for very small/large values (`toExponential(3)` when `abs < 1e-3` or `>= 1e5`).
- `formatError`: `LabError` → `` `${code}: ${message}` ``; other `Error` → `message`; unknown → `Unexpected error`.

- [ ] **Step 4: Write failing i18n tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { COPY, formatCopy } from '../apps/web/dist/apps/web/src/i18n.js';

test('every UI string exists in both languages and is non-empty', () => {
  assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.zh).sort());
  for (const lang of ['en', 'zh']) {
    for (const [key, value] of Object.entries(COPY[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key}`);
      assert.ok(value.trim().length > 0, `${lang}.${key}`);
    }
  }
});

test('formatCopy fills named placeholders without touching other text', () => {
  assert.equal(formatCopy('Run seed {seed}', { seed: 7 }), 'Run seed 7');
  assert.equal(formatCopy('{a} / {b}', { a: 'x', b: 2 }), 'x / 2');
});
```

Required keys (both languages): `appTitle`, `tagline`, `modelLabel`, `seedLabel`, `tokensLabel`, `faultLabel`, `faultNone`, `faultPositionOffset`, `faultCacheOverwrite`, `faultMaskCurrentOnly`, `runButton`, `running`, `pass`, `diverged`, `firstDivergence`, `maxAbs`, `maxRel`, `fingerprint`, `engine`, `captureTitle`, `captureHint`, `stepTitle`, `stepHint`, `cacheTitle`, `cacheHint`, `layerLabel`, `slotLabel`, `readCount`, `overwritten`, `pagingTitle`, `pagingHint`, `pageSize`, `pageCount`, `requestId`, `appendTokens`, `appendButton`, `releaseButton`, `usedPages`, `freePages`, `logicalBytes`, `allocatedBytes`, `wasteBytes`, `exportTitle`, `exportButton`, `exportHint`, `importTitle`, `importButton`, `importHint`, `invalidInput`, `invalidDocument`, `oom`, `computeTime`, `notGpuTime`, `langButton`, `routeBaseline`, `routeCache`, `routeFault`, `routePaging`, `routeExport`, `explainBaselineEn`, `explainBaselineZh`, `explainCacheEn`, `explainCacheZh`, `explainFaultEn`, `explainFaultZh`, `explainPagingEn`, `explainPagingZh`, `skipLink`, `footerNote`.

- [ ] **Step 5: Run i18n tests red then green**

Run: `node --test tests/web-i18n.test.mjs` → FAIL (module missing), implement, rerun → PASS. Then run `node --test tests/web-*.test.mjs` → all pass. Save logs to `artifacts/a2/task2-viewmodel.log` and `artifacts/a2/task2-i18n.log`.

---

### Task 3: Dependency-free CDP harness, red against the shell

**Files:**
- Create: `scripts/e2e-web.mjs`
- Test: `tests/e2e-harness.test.mjs`
- Modify: `package.json` (`"e2e:web": "node scripts/e2e-web.mjs"`)

**Interfaces:**
- Produces: `parseDevToolsActivePort(text): { port: number; wsPath: string }`.
- Produces: `isLocalResource(url, origin): boolean`.
- Produces: `createCdp(wsUrl): Promise<{ send(method, params?): Promise<any>; close(): Promise<void> }>`.
- Produces: `runE2E({ sections?: string[] }): Promise<{ ok: boolean; results: Array<{ name: string; ok: boolean; detail: string }> }>`; CLI writes `artifacts/a2/e2e.json` and screenshots, exits 0/1.

- [ ] **Step 1: Write the failing harness-helper test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDevToolsActivePort, isLocalResource } from '../scripts/e2e-web.mjs';

test('DevTools port file is parsed strictly', () => {
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc\n'), { port: 9222, wsPath: '/devtools/browser/abc' });
  assert.deepEqual(parseDevToolsActivePort('0\n/devtools/browser/x'), { port: 0, wsPath: '/devtools/browser/x' });
  for (const bad of ['', 'abc\n/x', '9222', '9222\n']) assert.throws(() => parseDevToolsActivePort(bad), /DevTools/);
});

test('resource origins are compared exactly', () => {
  assert.equal(isLocalResource('http://127.0.0.1:4173/apps/web/src/main.js', 'http://127.0.0.1:4173'), true);
  assert.equal(isLocalResource('http://127.0.0.1:4173.evil.test/x', 'http://127.0.0.1:4173'), false);
  assert.equal(isLocalResource('https://cdn.example/x.js', 'http://127.0.0.1:4173'), false);
  assert.equal(isLocalResource('data:image/svg+xml,x', 'http://127.0.0.1:4173'), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/e2e-harness.test.mjs`
Expected: FAIL because `scripts/e2e-web.mjs` does not exist.

- [ ] **Step 3: Implement the harness core**

`scripts/e2e-web.mjs` must:

1. Find a browser: `LAB_BROWSER` if set and exists; else Edge at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` or `C:/Program Files/Microsoft/Edge/Application/msedge.exe`; else Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` or `C:/Program Files (x86)/Google/Chrome/Application/chrome.exe`; else fail with a clear message.
2. Build web (`buildWeb()`), create a root temp profile via `mkdtempSync`, spawn the browser with `--headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --user-data-dir=<profile> --remote-debugging-port=0 about:blank`, `stdio: 'ignore'`, `windowsHide: true`.
3. Wait up to 15 s for `<profile>/DevToolsActivePort`; parse it; `fetch('http://127.0.0.1:<port>/json/list')`; pick the `page` target; connect with global `WebSocket`; enable `Runtime`, `Page`, `Log`, `Network`; collect console errors and exceptions.
4. Start the static server on `127.0.0.1:0`, navigate to `/`, wait for `document.readyState === 'complete'` and `window.__lab?.ready === true` (poll every 50 ms, 10 s timeout).
5. Provide helpers: `evaluate(expression)`, `waitFor(expression, timeout)`, `click(selector)` (element `.click()`), `setValue(selector, value)` (native setter + `input`/`change` events), `text(selector)`, `attr(selector, name)`, `screenshot(path)` via `Page.captureScreenshot` and `writeFileSync(..., 'base64')`, `setViewport(width,height)`, `emulateReducedMotion()`.
6. Run sections in order: `load`, `baseline`, `input`, `fault`, `step`, `cache`, `paging`, `language`, `export`, `xss`, `a11y`, `narrow`, `motion`, `perf`, `resources`. Each section pushes `{ name, ok, detail }`; a thrown error marks that section failed but the harness continues to the next section. Final `ok` is every section true.
7. Always write `artifacts/a2/e2e.json` with sections, screenshots, browser user agent, and a `generatedAt` timestamp (this is a test receipt, not a deterministic experiment report; timestamp is allowed here). Clean up: close WS, `Browser.close`, wait for child exit (5 s), kill only that child if needed, remove the temp profile with up to 3 retries, close server.
8. Support `--only=baseline,fault` to run a subset; unknown section names fail.

- [ ] **Step 4: Run red against the shell and record it**

Run: `node scripts/e2e-web.mjs`
Expected: the harness boots the browser and server, then `load`/`baseline` fail because `#run-button` does not exist. Exit 1. Copy the console output to `artifacts/a2/e2e-red.log`. This is the required failing test before UI code.

---

### Task 4: Scenario controls, run, summary and capture bar

**Files:**
- Modify: `apps/web/static/index.html`
- Modify: `apps/web/static/styles.css`
- Modify: `apps/web/src/main.ts`

**DOM contract (exact IDs/attributes):**

- `#scenario-form` contains `#tokens-input`, `#seed-input`, fault radios `input[name="fault"]` with values `none|position-offset|cache-overwrite|mask-current-only`, and `#run-button` (`type="button"`).
- `#run-status` is `aria-live="polite"`; `#status-lamp` carries `data-state="idle|running|pass|fail"`.
- `#summary` contains `[data-field="passes"]`, `[data-field="first-divergence"]`, `[data-field="max-abs"]`, `[data-field="max-rel"]`, `[data-field="fingerprint"]`, `[data-field="engine"]`, `[data-field="compute"]`.
- `#capture` contains one `button.capture-col[data-position="N"]` per token, with `aria-label="Position N, token T"` and classes `is-diverged` / `is-selected`.
- `#step-table tbody` has one `tr[data-position="N"]` per position; each row's first cell is a `button.step-select[data-position="N"]`.
- `window.__lab` exposes `{ ready, runCount, lastRunMs, lastInput, lastResult }`; `lastResult` is the actual `ExperimentResult`.

- [ ] **Step 1: Run the focused E2E and watch baseline fail**

Run: `node scripts/e2e-web.mjs --only=load,baseline`
Expected: FAIL with a missing `#run-button` or missing summary field.

- [ ] **Step 2: Build the shell and controls**

`index.html` structure:

```html
<header class="masthead">
  <p class="stamp">LLM SYSTEMS LAB / NUMERICAL</p>
  <h1>See what the cache actually does.</h1>
  <p class="lede">A tiny decoder you can break, inspect and restore.</p>
  <p class="spec">tiny-decoder-v1 · 2 layers · 2 heads · 16 dim · 32 vocab</p>
</header>
<main id="main">
  <section class="console">
    <aside class="rail" aria-label="Experiment controls">…</aside>
    <section class="instrument">…</section>
  </section>
</main>
```

The rail holds the form with labelled inputs, the fault fieldset, the run button, the language button, and the route list. The instrument holds the capture bar, summary, step table and detail, cache grid, paging, export/import panels (later tasks can add empty panels with headings).

`main.ts` state:

```ts
interface State {
  lang: Lang;
  input: ExperimentInput;
  result: ExperimentResult | null;
  selectedPosition: number;
  paging: { pageSize: number; pageCount: number; requestId: string; pool: PagePool; operations: PagingOperation[] };
  error: string | null;
}
```

On `#run-button` click: parse tokens and seed; build `ExperimentInput`; set status `running`; `const started = performance.now()`; `const result = await runExperiment(input)`; `lastRunMs = performance.now() - started`; update state; render; increment `runCount`. On `LabError`, show `code: message` in `#run-status`, keep the last valid result, set lamp `fail`. Render all dynamic text with `textContent`.

- [ ] **Step 3: Render the capture bar and summary from the result**

`buildCapture` drives the columns. Each column is a button; clicking sets `selectedPosition`, re-renders, and updates `aria-current="step"` on the selected column. Marks: write = 8 px amber bar, read = 8 px teal bar, overwrite = 8 px red bar with a diagonal hatch. A fault column shows `▲` and the text "DIVERGED at N". Summary values use `formatNumber`/`formatBytes` and `summary.passes ? COPY.pass : COPY.diverged`.

- [ ] **Step 4: Rerun the focused E2E until green**

Run: `node scripts/e2e-web.mjs --only=load,baseline,input`
Expected: PASS for those sections. Save output to `artifacts/a2/task4-e2e.log`. Existing TypeScript tests and web unit tests must still pass.

---

### Task 5: Fault teaching, step detail and KV cache view

**Files:**
- Modify: `apps/web/static/index.html`
- Modify: `apps/web/static/styles.css`
- Modify: `apps/web/src/main.ts`

- [ ] **Step 1: Run the focused E2E and watch it fail**

Run: `node scripts/e2e-web.mjs --only=fault,step,cache`
Expected: FAIL because fault markers, step detail and cache cells are missing.

- [ ] **Step 2: Implement the step table and detail panel**

Each row shows position, token, PASS/DIVERGED, `max |Δ|` and a select button. The detail panel for the selected position shows: full-vs-cached logits pass/fail, max absolute and relative error, hidden-state status for layer 0 and 1, and a list of cache events with `layer`, `writeSlot`, `readSlots`, `overwrittenSlot`. Text only; no table cell uses `innerHTML`.

- [ ] **Step 3: Implement the cache grid**

Render `buildCacheSlots(result)` as two layer sections (one per layer). Each slot is a `div.slot[data-layer="L"][data-slot="N"]` with `textContent` of the slot number, a read-count badge, and classes `is-written`, `is-read`, `is-overwritten`. Add an accessible text summary: `Layer L, slot N: written, read K times` (or `not written`). The grid must use CSS grid with `grid-template-columns: repeat(auto-fit, minmax(3.5rem, 1fr))`, not fixed pixel widths.

- [ ] **Step 4: Make fault selection and step selection observable**

Selecting a fault radio updates state and the teaching text; it does not auto-run (the user must press Run, so the before/after is explicit). After a run, the first diverged capture column receives `is-diverged`, its table row receives `is-diverged`, and the detail panel defaults to that position. Clicking any capture column or step button updates `selectedPosition`, `aria-current`, and the detail.

- [ ] **Step 5: Rerun focused E2E until green**

Run: `node scripts/e2e-web.mjs --only=fault,step,cache`
Expected: PASS. Save `artifacts/a2/task5-e2e.log`.

---

### Task 6: Single-request paging experiment

**Files:**
- Modify: `apps/web/static/index.html`
- Modify: `apps/web/static/styles.css`
- Modify: `apps/web/src/main.ts`

**DOM contract:** `#paging-form` contains `#page-size`, `#page-count`, `#request-id`, `#append-tokens`, `#append-button`, `#release-button`; `#paging-status` is `aria-live="polite"`; `#page-map` contains `div.page-cell[data-page="N"]` with `data-owner`; `#paging-summary` contains `[data-field="used-pages"]`, `[data-field="free-pages"]`, `[data-field="logical-bytes"]`, `[data-field="allocated-bytes"]`, `[data-field="waste-bytes"]`.

- [ ] **Step 1: Run focused E2E and watch paging fail**

Run: `node scripts/e2e-web.mjs --only=paging`
Expected: FAIL (missing controls).

- [ ] **Step 2: Implement paging state and operations**

Initialize `new PagePool(16, 4)`. Changing page size or page count creates a fresh pool and clears the operation log, with a visible note that this resets the experiment. Append: validate request id and token count through `PagePool`; on success push `{ op: 'append', id, tokens }` and render; on `LabError` show `formatError` and leave the pool unchanged (the simulator is atomic). Release: same pattern with `{ op: 'release', id }`.

- [ ] **Step 3: Render page map and accounting**

Each page cell shows the page number and owner or "free"; owned cells are teal, free are outlined; the used page count is computed only from `pagingView(pool.snapshot())`. The summary shows logical bytes, allocated bytes, waste bytes and capacity, all via `formatBytes`. Include the exact sentence: "Logical KV bytes, not process RSS or GPU memory." (Chinese equivalent in the explanation).

- [ ] **Step 4: Verify OOM is atomic in the UI**

Append enough tokens to exceed capacity; the UI must show `OOM: …`, keep the previously used pages unchanged, and not add the failed operation to the exported log. Save `artifacts/a2/task6-e2e.log`.

---

### Task 7: Export/import, language toggle and XSS boundary

**Files:**
- Modify: `apps/web/static/index.html`
- Modify: `apps/web/static/styles.css`
- Modify: `apps/web/src/main.ts`

**DOM contract:** `#export-button`, `#export-output` (readonly `textarea`), `#import-input` (`textarea`), `#import-button`, `#import-status` (`aria-live="polite"`), `#lang-button`.

- [ ] **Step 1: Run focused E2E and watch it fail**

Run: `node scripts/e2e-web.mjs --only=language,export,xss`
Expected: FAIL (missing controls).

- [ ] **Step 2: Implement export**

Build the document with `buildExperimentDocument(state.input, { pageSize, pageCount, operations })`, serialize with `JSON.stringify(doc, null, 2)`, put it in `#export-output`, and trigger a download of `llm-systems-lab-experiment.json` via a Blob URL. The textarea is the testable path; the download is a convenience. Revoke the object URL after the click.

- [ ] **Step 3: Implement import with validation and replay**

Read `#import-input`; `parseExperimentDocument`; on error show `formatError` and change nothing. On success replace `state.input`, rebuild the paging pool from `doc.paging` via `replayPaging`, set operation log, run the experiment again with `runExperiment(doc.input)`, and render. Never trust result fields from the document; the document schema contains none. Cap the textarea at 262144 characters before parsing and show the limit in the message.

- [ ] **Step 4: Implement the language toggle**

Toggle `lang`; set `document.documentElement.lang`; update all `[data-copy]` elements from `COPY[lang]`; keep both explanation paragraphs visible (English and Chinese) regardless of chrome language. `#lang-button` text is `中文` when English is active and `English` when Chinese is active.

- [ ] **Step 5: Add the XSS regression**

In the E2E `xss` section: set `window.__xss = undefined`; set the request id to `<img src=x onerror="window.__xss=1">` and press Append; assert the rejection is shown, `document.querySelector('img') === null`, and `window.__xss === undefined`. Import a document with an extra `note: '<img src=x onerror="window.__xss=1">'`; assert rejection and no image. Import valid JSON after that; assert recovery.

- [ ] **Step 6: Rerun focused E2E until green**

Run: `node scripts/e2e-web.mjs --only=language,export,xss`
Expected: PASS. Save `artifacts/a2/task7-e2e.log`.

---

### Task 8: Accessibility, responsive layout, reduced motion, performance and visual finish

**Files:**
- Modify: `apps/web/static/index.html`
- Modify: `apps/web/static/styles.css`
- Modify: `apps/web/src/main.ts`
- Modify: `scripts/e2e-web.mjs` (only to add assertions, not to weaken existing ones)

- [ ] **Step 1: Run focused E2E and watch it fail**

Run: `node scripts/e2e-web.mjs --only=a11y,narrow,motion,perf,resources`
Expected: FAIL on missing accessible names, overflow, motion or performance assertions.

- [ ] **Step 2: Finish the visual system**

Apply the locked tokens and type faces. The capture bar is the hero. Panels have 1 px `--rule` borders, 2 px radius, no shadows. Buttons are flat: primary uses `background: var(--ink); color: var(--surface)`, secondary uses transparent with a 1 px ink border. Never place white highlights or glows on solid controls. Tables use the data face, right-aligned numeric columns, zebra rows via `background: color-mix(in srgb, var(--surface) 70%, var(--paper))` and 1 px rules. The status lamp is a 10 px square with a 1.2 s opacity pulse only while `data-state="running"`.

- [ ] **Step 3: Accessibility pass**

- Skip link first in tab order; `#main` has `tabindex="-1"` and receives focus after skip.
- Every input has a `<label for>`; the fault group uses `<fieldset><legend>`.
- Buttons have `type="button"`; no positive tabindex; focus outline is 2 px `--signal` with 2 px offset.
- `#run-status`, `#paging-status`, `#import-status` are polite live regions.
- Capture columns and page cells have text alternatives; `aria-current="step"` is set only on the selected capture column.
- Headings descend `h1 → h2 → h3`; each panel has an `h2`.
- E2E `a11y` section asserts: every `input/select/textarea/button` has a non-empty accessible name (label text, aria-label, or textContent); every button has `type="button"`; no positive `tabindex`; exactly one `h1`; `main`, `header`, `footer` landmarks exist; `getComputedStyle` focus outline width ≥ 2 px on `#run-button` after `focus()`.

- [ ] **Step 4: Responsive and reduced motion**

At `max-width: 959px`, the console becomes one column and the rail is not sticky. At `max-width: 640px`, tables switch to a horizontally scrollable wrapper with `tabindex="0"` and an accessible label, and the capture bar scrolls horizontally rather than shrinking marks below 10 px. E2E `narrow` sets 360×800 and 640×800, asserts `document.documentElement.scrollWidth <= window.innerWidth + 1`, and saves screenshots. E2E `motion` emulates `prefers-reduced-motion: reduce` and asserts the status lamp's `animationName === 'none'` and `transitionDuration === '0s'`.

- [ ] **Step 5: Performance and resource budget**

Run a 64-token scenario in the page; assert `window.__lab.lastRunMs < 200`, `#summary [data-field="compute"]` shows a finite millisecond value, and the label says "UI compute only; not GPU time" (or Chinese). If the budget fails, add a module Worker that imports the same core and returns the result; do not change the core or lower the token cap. E2E `resources`: `performance.getEntriesByType('resource')` every URL must be same-origin; assert total transferred ≤ 2 MiB; assert no request URL contains `http://` or `https://` for any origin other than the local server.

- [ ] **Step 6: Capture the visual evidence**

E2E writes `artifacts/a2/desktop.png` (1280×900 baseline), `artifacts/a2/fault.png` (fault state), `artifacts/a2/narrow.png` (360×800), and `artifacts/a2/export.png`. Inspect each screenshot for clipped text, overlapping controls, unreadable contrast and the signature capture bar. Record observations in `artifacts/a2/visual-review.md`; do not claim visual quality from code inspection alone.

- [ ] **Step 7: Run all E2E sections**

Run: `node scripts/e2e-web.mjs`
Expected: every section OK; `artifacts/a2/e2e.json` has `ok: true` and all screenshots. Save console output to `artifacts/a2/e2e-final.log`.

---

### Task 9: Verification gate, README and handover

**Files:**
- Modify: `scripts/verify.mjs`
- Modify: `README.md`
- Modify: `docs/NUMERICAL_CONTRACT.md` (only if UI reveals a contract ambiguity; otherwise no change)
- Modify: the internal project handover (§0.3, §15.1, §15.3, version line; not part of this repository)
- Modify: `.superpowers/sdd/2026-11-11-browser-ui/progress.md` (new ledger for this plan)

- [ ] **Step 1: Extend the serial gate to eight stages**

Add after the existing build stage: `web-build` (calls `buildWeb` and asserts the 2 MiB budget) and after TypeScript tests: `web-tests` (`node --test tests/web-*.test.mjs`, requiring all pass and at least the count of web tests present on disk; fail closed if zero). Keep the six A1 stages unchanged. Update the receipt to include `web: { bytes, files, tests }`. Add a negative control: `WEB_MAX_BYTES=1 node scripts/verify.mjs` exits 1 at the web-build stage; record `artifacts/a2/verify-negative-web.log`.

- [ ] **Step 2: Run the full gate**

Run: `node scripts/verify.mjs`
Expected: 8/8 stages PASS; `artifacts/verify.log` and `artifacts/verify-receipt.json` updated. Existing A1 numbers must remain: 71/71 TS, 18/18 Python, 130 fixture cases, 6/6 mutants, packed CLI smoke.

- [ ] **Step 3: Update README**

Change status from A1 to A2. Add: how to build/serve (`node scripts/build-web.mjs`, `node scripts/serve-web.mjs`, open `http://127.0.0.1:4173`), what the teaching route covers, the E2E command and its browser prerequisite, the exact UI limits (64 tokens, 256 KiB import, 1000 ops), and the fact that the page has no external requests and no analytics. Keep both languages. Do not claim user testing, visual quality or learning effectiveness.

- [ ] **Step 4: Update the handover**

- Version line to 1.4 (A2 complete, A1 unchanged).
- §0.3: add A2's actual results, the number of web tests, E2E sections/screenshots, asset bytes, and the remaining user-testing/publication gaps.
- §15.1: P1 row becomes A2 complete; next action is A3 (public beta) only after user review.
- §15.3: append a dated row with exact commands, receipt paths, browser version, screenshot paths, known limitations.
- Do not claim stars, users, learning outcomes, GPU performance or public release.

- [ ] **Step 5: Final independent review**

Dispatch a read-only reviewer with the plan, the diff (untracked files list plus key file contents), the E2E receipt and screenshots. Ask specifically: does the UI recompute answers, can imported data execute, are the limits enforced, are the a11y/motion/narrow claims actually tested, and does the gate fail closed. Fix findings and rerun both gates. Record the verdict in the ledger; do not claim approval before it arrives.

---

## Self-Review Checklist (run before declaring the plan ready)

- [ ] Every A2 requirement in handover §5.4/§6 maps to a task: teaching route (Tasks 4–5), single-request paging (Task 6), replay/export (Task 7), keyboard/bilingual/narrow/reduced motion (Task 8), clean-browser reproducibility (Task 3 + 9), XSS/limits/offline (Tasks 4, 7, 8), 2 MiB/200 ms budgets (Tasks 1, 8).
- [ ] No task edits `packages/core` or the Python reference; the UI consumes them.
- [ ] Every test command is runnable on this Windows machine with `node` directly.
- [ ] No task claims a pass without a log or receipt path.
- [ ] No commit or publish step exists anywhere in this plan.
