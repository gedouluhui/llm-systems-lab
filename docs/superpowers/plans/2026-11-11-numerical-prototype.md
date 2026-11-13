# A0–A1 Numerical Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver an offline, independently checked tiny decoder, KV-cache fault laboratory, paging ledger and reproducible CLI before building the browser application.

**Architecture:** TypeScript numerical code has no runtime dependencies, DOM access or network calls. A separately written NumPy full-matrix implementation supplies checked-in reference cases. A standalone paging model and CLI consume stable contracts; simulated accounting is never reported as measured GPU performance.

**Tech Stack:** TypeScript 5.9.3, Node >=22.18, Node built-in test runner; Python >=3.11 with NumPy 2.x for independent verification. This machine has Node 26.13.0/Python 3.12.3/NumPy 2.4.6; lower-version compatibility remains unverified until tested.

**Spec:** [NUMERICAL_CONTRACT.md](../../NUMERICAL_CONTRACT.md)

## Global Constraints

- Untrained synthetic model, 32 token IDs, 64-token context, 2 layers, 2 heads, headDim=8, width=16, ff=32.
- Float32 weights/materialized activations, Float64 accumulations; explicit rounding boundaries are in the contract.
- atol=1e-5, rtol=1e-4; do not change them in response to unexplained failures.
- Three explicit faults: position-offset, cache-overwrite, mask-current-only; normal mode is none.
- No dependency on a model API, GPU, private files, existing proxy configuration or competition processes.
- Work only inside this new repository. Do not initialize/version the parent mixed-data workspace.
- Use TLS certificate verification for package operations even if the caller inherited NODE_TLS_REJECT_UNAUTHORIZED=0. Do not alter global TLS/network settings.
- No commits or pushes in A1 unless specifically requested; the user has approved development and eventual open source, not publication of an unverified prototype.
- No product implementation before its failing tests. Python reference is independent: it reads this contract, not TypeScript code.

## File map

| Files | Responsibility |
|---|---|
| package.json, package-lock.json, tsconfig.json, .gitignore | Isolated build and test configuration |
| packages/contracts/index.ts | Input validation, typed errors, constants and fault names |
| packages/core/math.ts | Materialized float32 vector operations with double accumulators |
| packages/core/model.ts | Weight generation, deterministic serialization and fingerprint |
| packages/core/decoder.ts | Separate full-prefix and cached forward paths, cache snapshots and explicit fault behavior |
| packages/core/experiment.ts, index.ts | Comparisons, repeatable experiment results and safe report replay |
| packages/simulator/index.ts | Page allocation, release, OOM atomicity, copied snapshots and byte accounting |
| src/cli.ts | Argument parsing, bounded local report input, JSON/human output and exit codes |
| reference/decoder.py, test_decoder.py, generate_cases.py | Independent matrix implementation, its self-tests, explicit fixture generation |
| tests/fixtures/reference.json | Versioned synthetic reference inputs/results/provenance |
| tests/*.test.mjs | Behavior, cross-language, paging, CLI and mutation-runner tests |
| scripts/verify.mjs, mutation-check.mjs | Acceptance receipt and isolated source-mutant checks |
| README.md, README.zh-CN.md, LICENSE | Runnable instructions, boundaries, provenance and code license |
| artifacts/ | Ignored generated receipts; not hand-edited truth |

## Task 1: Establish validated numerical inputs and weight identity

**Interfaces:**
- `validateInput(value: unknown): ExperimentInput` with exactly schemaVersion, seed, tokens, fault; returns a defensive copy.
- `LabError extends Error` exposes `code` string, separating INPUT, CONTEXT_LIMIT and NON_FINITE failures.
- `createModel(seed: number): Model`; `weightsFingerprint(model: Model): Promise<string>`.
- `Model` has embeddings/positions, layers of q/k/v/o/up/down matrices, and lmHead.

- [x] Write package scripts: build=`tsc -p tsconfig.json`, test=`npm run build && node --test tests/*.test.mjs`, demo=`npm run build && node dist/src/cli.js demo`. Exclude tests and artifacts from TS emission. Use explicit `.js` relative imports under NodeNext; emit declarations.
- [x] Create empty exported module scaffolds and write tests before functionality. The first expected failure is a named assertion that input validation is unavailable, not a typo or module lookup failure.

```js
assert.equal(typeof contracts.validateInput, 'function');
const source={schemaVersion:1,seed:0,tokens:[0,31],fault:'none'};
const validated=contracts.validateInput(source);
source.tokens[0]=9;
assert.deepEqual(validated.tokens,[0,31]);
for (const tokens of [[],[-1],[32],[1.5],[true],Array(65).fill(1)]) {
  assert.throws(()=>contracts.validateInput({...source,tokens}));
}
```

- [x] Run focused tests and retain the expected failure output before implementing strict types/keys, integer seed bounds and token bounds.
- [x] Write model tests for same seed/different seed, shape, float32 storage, finite values and seed=1 first generated states 1015568748 then 1586005467. Check weight bytes against independent reference when available.
- [x] Implement LCG using `state=(Math.imul(state,1664525)+1013904223)>>>0`, weight=`Math.fround((state/4294967296-0.5)*0.6)`, in the contract's exact order. Serialize via DataView.setFloat32(offset,value,true), hash with Web Crypto SHA-256.
- [x] Build and rerun tests. No Git commit in this task; record verified files and results in the handover.

## Task 2: Implement the independent full-matrix reference

**Interfaces:** `make_weights(seed)`, `forward(tokens, weights)`, `weights_sha256(weights)` as specified in NUMERICAL_CONTRACT.md. Fixture shape/provenance is defined there; no TypeScript imports.

- [x] A dedicated implementer reads only the mathematical contract and writes unittest tests first. Require zero weights to produce zero logits; adding a suffix must not change earlier logits; different seeds produce different weight bytes; invalid tokens/seeds are rejected.

```python
w = make_weights(7)
short = forward([1, 2, 3], w)
long = forward([1, 2, 3, 4, 5], w)
np.testing.assert_allclose(short['logits'], long['logits'][:3], atol=1e-5, rtol=1e-4)
```

- [x] Run `python -m unittest discover -s reference -p 'test_*.py' -v` to see the missing implementation fail.
- [x] Implement full-sequence matrix algebra, not incremental caching. Use explicit float64 casts for dot products, rowwise mean/variance, stable triangular masked softmax; cast every specified materialized result to float32. Use independent code for weight bytes.
- [x] Rerun Python tests; generate the reserved fixture explicitly with `python reference/generate_cases.py --output tests/fixtures/reference.json`. Generator must refuse overwrite without `--force`, and include a digest of the generator and decoder source.
- [x] Review actual files and values before treating agent output as verified. Fixture creation is not evidence that the TypeScript engine agrees.

## Task 3: Full/cached inference and observable teaching faults

**Interfaces:**
- `fullForward(model: Model,tokens: readonly number[]): ForwardResult` with logits/cache/hidden.
- `new CachedDecoder(model, fault='none')`; `step(token): StepResult`; `snapshot(): LayerCacheSnapshot[]`; `reset()`; `length`.
- `StepResult` includes logits, hidden per layer, position, token, and cache events recording layer/writeSlot/readSlots/overwrittenSlot.

- [x] Write failing tests for output dimensions/finiteness, suffix causality, cache-prefix equality, defensive snapshots, independent decoder instances, reset and invalid-input atomicity.
- [x] Write a known scalar example for LN and softmax so shared helpers are not validated only by two callers sharing the same error.

```js
const model=createModel(7);
const decoder=new CachedDecoder(model);
const tokens=[1,4,2,8,3,9];
for (let i=0;i<tokens.length;i++) {
  const step=decoder.step(tokens[i]);
  const full=fullForward(model,tokens.slice(0,i+1));
  compareAll(step.logits,full.logits[i]);
}
assert.throws(()=>decoder.step(32));
assert.equal(decoder.length,tokens.length);
```

- [x] Implement math.ts with dot-product accumulation, stable softmax, LN, add and ReLU. Materialize via Float32Array only at the documented boundaries; reject non-finite results.
- [x] Implement fullForward with a full-prefix triangular path and CachedDecoder with append-only per-layer storage. Fault branches change actual position selection, stored K/V or attention reads; never synthesize an error in a result field.
- [x] Read the fixture and compare every logit, every layer hidden vector and all K/V elements on all reserved cases; also compare weight hashes. Test missing/stale fixture metadata as a clear verification failure, not a skip.
- [x] For seed=7 and tokens=[1,4,2,8,3,9], assert all faults match at position 0 and eventually diverge beyond fixed tolerance. Verify a fresh normal decoder recovers. Run source mutations later as an additional test of the checker itself.

## Task 4: Atomic paging model with independent accounting

**Interfaces:** `new PagePool(pageSize:number,pageCount:number)`; `append(id,count)`; `release(id)`; `snapshot()`.

- [x] Write the following known examples and atomic OOM/invalid release tests before implementation.

```js
const pool=new PagePool(16,4);
pool.append('a',32);
assert.equal(pool.snapshot().logicalBytes,8192);
pool.append('a',1);
assert.equal(pool.snapshot().allocatedBytes,12288);
assert.equal(pool.snapshot().wasteBytes,3840);
const before=pool.snapshot();
assert.throws(()=>pool.append('a',32));
assert.deepEqual(pool.snapshot(),before);
```

- [x] Implement lowest-free-page allocation after all validation/capacity checks. Snapshot returns arrays/records, not references to Map or live page vectors. Requests cannot claim the same physical page.
- [x] Add two-request fragmentation test (one token each must occupy two pages), release/reuse test, constructor/input limits and empty snapshot.
- [x] Run at least 1000 deterministic append/release operations against a separate Map of logical token counts. Compute expected allocation from `sum(ceil(n/pageSize))`; compare every operation, including rejected operations. Do not import allocator helpers into the oracle.

## Task 5: Experiments, CLI and independently falsifiable acceptance

**Interfaces:** `compareVectors(actual,reference)`, `runExperiment(input):Promise<ExperimentResult>`, `replayExperiment(report:unknown):Promise<ExperimentResult>`.

- [x] Write failing comparison tests for shape mismatches, NaN/Infinity, a differing non-argmax coordinate, and absolute/relative tolerance boundaries.
- [x] Write repeatability and replay tests: identical input yields deeply identical output, full vector comparisons determine summary, changed token changes real results, unsupported schemas/engines/model IDs and wrong weight hash reject.
- [x] Implement experiment assembly using actual full/cached results; layer errors and firstDivergence derive from comparisons, not the fault's name. Keep deterministic result free of timestamps/hostnames.
- [x] Write CLI subprocess tests before CLI code: normal run rc=0, faulty run rc=1, malformed flags/tokens/file rc=2; stdout JSON for run/replay, bounded replay file; demo only succeeds when all expected observations hold.
- [x] Implement the three commands. Limit file reading before JSON parsing; do not write user files or call a network service. Export output through stdout so shell redirection stays explicitly controlled by the caller.
- [x] Write mutation-runner tests with a deliberately surviving mutant and a no-op edit. Runner must mark these MISSED/NOP and fail, not infer success from arbitrary subprocess failure.
- [x] Implement mutation-check.mjs using fresh temporary copies inside ignored scratch storage. Single run only; never mutate live source. Require target uniqueness, nonempty diff, successful build, and named test assertion failure. Mutants: wrong position, corrupted cache, wrong mask, comparison always-pass, floor instead of ceil pages, skipped validation. Run good baseline first and at the end.
- [x] Implement verify.mjs to run the build/tests, reference self-tests, fixture-provenance check and mutations serially; print actual results and source/fixture hashes. Nonzero or missing components must fail, not silently skip. Write ignored JSON receipt only after command outcomes are known.
- [x] Run a clean packed-artifact smoke test (npm pack into ignored artifacts, extract to a fresh directory, execute CLI without source or Python). Verify runtime dependency-free distribution contains no fixtures/private files/secrets. No upload yet.
- [x] Write bilingual README, MIT LICENSE and update the top-level handover with what actually ran, the final commands, evidence paths, unresolved UI/user-testing/publication stages and next action.

## Plan self-review

Coverage: A-COR-1/2 through Tasks 2–3/5; A-MEM-1 through Task 4; A-REP-1's CLI portion through Task 5. A-UI-1/2, browser security, first-load assets and A-LEARN-1 belong to A2–A4 and are explicitly not completed by this numerical milestone. No runtime API calls are required. Named functions and structures above are the execution contracts; implementers may add private helpers but must not change rounding or artifact semantics without a recorded contract revision.

Execution choice: inline implementation, with one independent reference implementer and a final independent read-only reviewer. The user requested us to decide and start, so no extra choice prompt is needed. No automated commit/push until a concrete verified publication is prepared.
