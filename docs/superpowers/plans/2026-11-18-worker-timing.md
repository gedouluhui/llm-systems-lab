# Web Worker and timing implementation plan

> Agentic execution: follow test-driven development, independent scoped review and owner verification. The user delegated design/implementation/review decisions and asked to continue; no additional approval round is pending. No commits or publication in this slice.

**Goal:** Keep numerical computation off the UI thread, reject obsolete results, and distinguish full-forward from cached-decoder wall time without changing deterministic experiment reports.

**Architecture:** `runTimedExperiment` returns a timing envelope around the same numerical runner, not new fields in ExperimentResult. A dedicated module Worker runs that API. A UI-side client owns its Worker and terminates obsolete, failed, timed-out or disposed instances; UI intent IDs guard every asynchronous completion, including imports and invalid new attempts.

**Tech stack:** Existing TypeScript 5.9.3, browser module Workers, Node tests and native CDP E2E; no new dependencies, hosted APIs, blob worker scripts or main-thread numerical fallback.

**Spec:** `docs/NUMERICAL_CONTRACT.md`; existing A2 browser plan; previous light-mode API in `packages/core/experiment.ts`. Baseline including uncommitted light work is retained at `artifacts/worker-baseline-cMoKDW/` with `sha256.json`.

## Global constraints and decisions

- Default `runExperiment`, explicit full, light, replay and expansion semantics/JSON are unchanged. Timing never appears inside those deterministic results.
- `fullForwardMs` measures only `fullForward(model,tokens)`; `cachedDecoderMs` sums only `decoder.step(token)` calls. Comparisons, snapshots, projection, model creation and hashing are not misbilled to either kernel.
- `totalMs` is elapsed wall time of the timed core call, including preparation/comparison; `roundTripMs` is client-side worker lifetime/transfer latency, excluding DOM rendering. None is CPU utilization time, GPU time or serving latency; do not claim a speedup.
- Each valid client request uses a dedicated module Worker URL relative to `import.meta.url`, served under CSP `worker-src 'self'`. No data/blob URLs, external requests or synchronous fallback.
- Latest intent wins. A new run/import attempt cancels the previous client promise; even invalid new input must prevent an older valid completion from changing the UI. Superseded promises are explicitly caught without displaying stale errors.
- Valid import commits paging, input controls and numerical result atomically only after its matching response. Page controls and language remain interactive while computing.
- Worker startup, runtime, message errors and timeout are explicit failures; future runs create a new worker and can recover. A 30-second timeout is a safety ceiling, not a benchmark target.
- User's existing browser processes must not be killed. E2E may launch and dispose only its own isolated browser.

## Files and interfaces

- `packages/core/experiment.ts`, `packages/core/index.ts`: shared runner and exported `runTimedExperiment`; new exported `ExperimentTiming`, `TimedExperimentResult<T>`.
- `apps/web/src/experiment-worker.ts`: worker-only message entry point.
- `apps/web/src/worker-client.ts`: one active owned worker, request IDs, cancellation, timeout/disposal, sanitized errors.
- `apps/web/src/worker-protocol.ts`: shared discriminated request/response types and validation helpers, no DOM dependencies.
- `apps/web/src/main.ts`: run/import consumers, intent guards, timing display and `__lab` observations; preserve all other UI flows.
- `apps/web/src/i18n.ts`, `apps/web/static/index.html`: bilingual wall-time labels and explicit same-origin Worker CSP.
- `scripts/build-web.mjs`, `tests/web-build.test.mjs`: assert worker module exists in the static bundle. Existing TS include glob already covers the new files; avoid adding conflicting DOM/WebWorker global libs.
- `tests/experiment-timing.test.mjs`, `tests/worker-client.test.mjs`: real numerical parity/timing boundaries and client lifecycle tests.
- `scripts/e2e-web.mjs`: real worker execution, rapid run/import ordering, errors/recovery, timing observations and responsive existing controls. Preserve previous checks.

```ts
interface ExperimentTiming {
  fullForwardMs: number;
  cachedDecoderMs: number;
  totalMs: number;
}
interface TimedExperimentResult<T> { result: T; timing: ExperimentTiming }
type WorkerRequest = { kind: 'run'; id: number; input: unknown };
type WorkerResponse =
  | { kind: 'result'; id: number; result: ExperimentResult; timing: ExperimentTiming; executionContext: 'worker' }
  | { kind: 'error'; id: number; error: { code: string; message: string } };
```

Overloads mirror `runExperiment`: omitted/explicit full returns `TimedExperimentResult<ExperimentResult>`; light returns the light type; optional union remains callable. The browser initially consumes full results to preserve cache/detail rendering; switching the UI to light is not required here.

## Task 1 — Timing envelope

- [x] Write failing tests for timed/default result deep equality across all faults, light parity, legacy JSON hashes, and positive/finite timing shape.
- [x] With a deterministic clock test double, require the exact full-forward interval and sum of per-step intervals, not elapsed comparison-loop time. Default untimed calls must not read the clock.
- [x] Refactor only enough to share computation and conditionally measure the two kernels. Keep comparisons over full vectors/cache and previous object field order.
- [x] Build and run `node --test tests/experiment-timing.test.mjs tests/experiment-light.test.mjs tests/experiment.test.mjs`.

```js
const normal = await runExperiment(input);
const timed = await runTimedExperiment(input);
assert.deepEqual(timed.result, normal);
assert.ok(timed.timing.totalMs >= timed.timing.fullForwardMs + timed.timing.cachedDecoderMs);
assert.equal(Object.hasOwn(normal, 'timing'), false);
```

## Task 2 — Worker protocol/client and UI

- [x] Write red tests: request IDs and defensive inputs, success/error shape, terminate-on-supersession, late-response immunity, startup failure, messageerror, timeout and dispose, then recovery with a new worker. Test transport doubles at this boundary only; do not mock the numerical result in end-to-end verification.
- [x] Implement worker handler calling `runTimedExperiment`; check worker execution context rather than infer it from a label. Unknown errors must not expose stack traces or local paths.
- [x] Implement client ownership; one active request, cancellation rejects with a distinct stale/cancelled error, handlers/timers removed and owned worker terminated on every terminal path.
- [x] Replace both direct `runExperiment` UI call sites. Increment intent before validation; ignore obsolete success/error; preserve atomic import semantics and runCount (only completed current results).
- [x] Display full-forward, cached-decoder and round-trip wall time. Preserve `lastRunMs` compatibility (round trip), add explicit timing fields and worker execution context for inspectable runtime evidence.
- [x] Add module bundle/CSP assertions, compile and run `npm test`.

## Task 3 — Browser verification and owner review

- [x] Extend CDP E2E with an actual Worker target or equivalent observed worker runtime evidence, latest-intent run/import tests, timing fields, error recovery and existing interactive controls. A hardcoded `__lab` flag alone is not proof of off-thread execution.
- [x] Run `npm run e2e:web`, recheck 375px layout and bilingual labels where new timing content appears.
- [x] The coordinating owner commissioned independent read-only review after implementation, then reran full tests, browser E2E, old-snapshot byte comparison and `npm run verify`; older receipts were preserved. The implementation agent itself did not spawn nested reviewers.
- [x] Update the handovers with actual results and limits. No publication, GPU speed or generalized responsiveness claim.

## Plan self-review

Timing feeds the protocol; protocol feeds the client; the client feeds both UI call sites. All consumers use a full deterministic result in an outer timing envelope. No task requires editing the numerical contract or importing browser globals into the core. The worker bundle is built by the existing recursive TypeScript include, and same-origin paths agree with the static host layout. Core-only tests remain runnable without a browser; off-thread claims require the separate real-browser gate.

## Progress

Implementation completed in the authorized P1 workspace, without commits, publication, dependency changes, permission/tsconfig changes or subagents. The original eight working-file SHA-256 values matched the snapshot before editing; existing light code/tests were retained.

### Actual TDD and verification evidence

- Timing red: `npm run build` then `node --test tests/experiment-timing.test.mjs` produced 7 failures (missing exported timed API) and 1 passing untimed regression. First green: timing + light + existing experiment tests, 62/62. Deterministic clock instrumentation executes the real kernels; exponentials consume one synthetic tick, comparison abs calls consume 100 ticks, and snapshot consumes 500 ticks. Kernel times exclude comparisons/snapshots; total includes them.
- Worker/client/bundle red: 13 failures, 1 pass, for absent worker modules/entry. Green: 14/14. Added exact module URL, defensive input copying, IDs, stale callbacks, cancellation, constructor/post/runtime/message/protocol errors, 30-second fake-clock timeout, disposal and fresh-worker recovery coverage. Later strengthened startup cost, independent client ownership and timed TypeScript overload checks.
- UI/browser red before replacing either call site: 0/4 selected sections passed (no actual worker target, superseded runCount increment, missing worker failure UI and timing labels). Implemented intent-before-validation, cancellation and guarded success/error, synchronous import commit, pending-language rendering, and bilingual timing.
- Browser integration caught an evidence-collection issue: Edge emits an empty URL in `Target.targetCreated`; the harness now follows `Target.targetInfoChanged`. Worker execution is proved by an attached CDP Worker target and `DedicatedWorkerGlobalScope`, not by the UI observation label. A paused worker blocks numerical completion while page/language controls remain usable. All five fault results compare byte-for-byte with a separately executed core runner.
- Self-review found the default Resource Timing buffer truncates at 250 entries. The harness now sets a 10,000-entry buffer before navigation and fails on overflow, without relaxing the 2 MiB or 200 ms gates. It also prints FAIL, not PASS, when a full E2E run has a failing section.
- Self-review reproduced a page lifecycle regression: cancelling a paused request on pagehide left a permanent running lamp. An actual browser event-flow red test failed with that message; the handler now restores non-pending display and permits another fresh worker. This tests lifecycle events, not a full browser history/BFCache navigation.
- A snapshot-loaded old implementation (transpiled only in memory, snapshot never overwritten) was compared with current default/full/light/timed/replay/expand across all faults, seeds 0/7/4294967295 and lengths 1/6/17/64: 240/240 byte comparisons passed.
- Full `npm test`: 166/166 passed; no skips. `npm run verify`: 8/8 stages passed, including 18 Python tests, 130 reference cases, 6/6 mutants and isolated packed CLI execution. A prior full-test failure was the exact i18n key inventory missing three new keys; the inventory was extended, not weakened.
- Full `npm run e2e:web`: 19/19 passed in isolated headless Edge, including preserved UI checks, latest run/import intent ordering, invalid newer attempts, atomic imports, sanitized errors/recovery, Worker evidence, and bilingual 375px timing screenshots. Native browser close/PID ownership only; no user browser pages were accessed.
- Final sequential rerun after the lifecycle fix: `npm test` 166/166; `npm run e2e:web` 19/19 (64-token round trip about 40 ms, 297 untruncated local resource entries totaling 1,820,173 bytes, no page errors); `npm run verify` 8/8. Static bundle: 16 files, 139,480 bytes. No performance or resource gate was relaxed.
- Older E2E outputs/screenshots and verify receipt were preserved under `artifacts/worker-prior-receipts-lT6d4Z/` before overwriting any receipt. The first worker-green verify receipt was also preserved there as `verify-first-worker-green.json` before the final rerun.

### Review and limits

The implementation agent performed its own scoped review and correctly did not spawn nested agents. The coordinating owner subsequently dispatched an independent read-only reviewer, who found no substantiated issue and observed a real Dedicated Worker target. The owner then read the actual diff/key modules and independently ran `npm test` (166/166), `npm run e2e:web` (19/19), and `npm run verify` (8/8). The owner also ran the pre-worker snapshot implementation against current default/timed/light/replay/expanded results: 225 JSON byte comparisons matched. These are compatibility comparisons, not independent statistical samples.

Owner E2E/verification output was preceded by an archive at `artifacts/worker-owner-prior-MrKJjH/`; fresh receipts are `artifacts/a2/e2e.json` and `artifacts/verify-receipt.json`. Both `timing-375-en.png` and `timing-375-zh.png` were opened and visually checked after the owner's run: labels/values are legible, explanatory text wraps, and no horizontal clipping is visible. The owner updated the two external project handovers separately.

Browser timeout/messageerror branches are deterministic client-boundary tests; they are not 30-second real-browser fault reproductions. No Firefox/Safari, hosted deployment, full BFCache-history flow, CPU utilization, GPU performance, serving latency or generalized speedup claims. No stylesheet or tsconfig changes were needed. Work remains uncommitted/unpublished; the cross-platform CI gate is the next P1 milestone.

## CI follow-up — implementation and local verification

Final owner verification after review fixes: **188/188 Node tests**, **8/8 workflow contracts**, **19/19 Windows browser E2E**, and **8/8 verify stages**. The owner inspected the actual startup watcher/test changes and ran the native ENOENT race: failed receipt exists, profile is removed, no-PID kill count is zero, and no error/exit/close listeners remain. A synchronous invalid-spawn-argument control also fails cleanly. `artifacts/ci-owner-prior-dVEG4v/` preserves earlier receipts/screenshots. Current receipts remain `artifacts/a2/e2e.json` and `artifacts/verify-receipt.json`.

Independent CI review confirmed the matrix/Pages dependency/failure propagation design and identified the prior startup-error hole plus the local-only contract test gap. Both were addressed; the final fixes were owner-verified, not described as a new independent APPROVE. Hosted Ubuntu/macOS/Windows runs, the CI's Node 22.18.0 environment and actual deployment remain **unverified** because this worktree has not been committed or pushed. A workflow configuration is not a record of successful hosted runs.


**Status:** Configuration and portable discovery implemented; local verification passed. GitHub's three-system matrix has **not** been executed, so cross-platform acceptance remains open.

- [x] `ci.yml` now uses `ubuntu-latest`, `windows-latest`, and `macos-latest`, with `fail-fast: false` and Bash for every run step. Each leg installs Node dependencies with `npm ci` and the existing NumPy requirement, runs `npm test`, the unchanged complete eight-stage verify command, and the unchanged full 19-section real-browser E2E. Node remains pinned to 22.18.0 and Python to 3.12.
- [x] Added `workflow_call` and `workflow_dispatch`; CI permissions remain only `contents: read`. Pages calls that local reusable workflow in `check`; `deploy` requires `check` under the default success condition. Only the deploy job retains Pages/OIDC write permissions. No `pull_request_target`, remote dispatch, deployment or repository-setting changes.
- [x] Evidence upload has `always()`, OS/run-ID/run-attempt names and an allowlist of E2E JSON/screenshots plus verify JSON/log. No whole-project, profile, backup, private file or hidden-file upload. Bash pipefail preserves a failing verify exit through `tee`.
- [x] `scripts/browser-discovery.mjs` retains Windows Edge/Chrome candidates, resolves Linux Chrome/Chromium commands from absolute PATH directories, and supports macOS Chrome/Edge application executables. It checks real executable files, keeps spaces/metacharacters as path data, resolves relative overrides to absolute paths, and rejects missing/directory/blank `LAB_BROWSER` overrides without fallback. No browser fails instead of skipping. E2E imports the helper; its handlers, thresholds and report/exit criteria are byte-identical to the pre-follow-up file.
- [x] Accounted for CRLF checkout compatibility without changing Git settings: CI normalizes only line endings in the two provenance-hashed Python sources. A disposable CRLF copy reproduced the digest mismatch; the workflow command restored the original fixture hashes. A subsequent source edit remained different, proving the step does not regenerate hashes or conceal source changes. This is a local CRLF test, not observation of a hosted Windows runner.

### Actual red → green evidence

- Browser discovery first red: 18 failures for the absent API; an additional relative-override regression was also run red before implementation. Green: 19 new discovery tests, including injected filesystem/platform boundaries and real filesystem existence/type checks. The original three E2E harness contract tests also passed (22/22 targeted).
- Workflow first red: 7 failures against the real original YAML structure (Linux-only job, missing reusable/manual triggers and unscoped Pages privileges). The extra CRLF-preparation test was separately observed red. Final green: 8/8 via `python tests/ci-contract.test.py -v`.
- Workflow tests use **PyYAML 6.0.2**, not string grep or a handwritten YAML parser. Initially they were local-only. Independent review identified that they would not automatically protect future workflow changes; the owner added a failing structural expectation, then inserted an unconditional CI-only install of pinned PyYAML and `python tests/ci-contract.test.py -v` before the numerical gates on each OS. They remain a separate command from `npm test`/verify and add no npm/product runtime dependency. The owner reran all eight workflow tests, including real command failures and CRLF/source-change controls.
- Two negative command tests copy real source/build inputs into disposable directories, never reuse the working receipt, and execute the actual parsed workflow commands with Bash's fail-fast/pipefail flags and a 120-second command ceiling. `WEB_MAX_BYTES=1` really exits 1 after build, records failed web-build and six skipped stages, and retains failure through `tee`. A missing `LAB_BROWSER` really exits 1 and writes a failed harness receipt with zero executed sections. These are not simulations of GitHub's scheduler or deployment service.
- Full local `npm test`: **185/185**, zero skips. Then sequentially, `node scripts/verify.mjs`: **8/8**, including 18 Python tests, 130 reference cases, 6/6 mutants and isolated packed CLI; `node scripts/e2e-web.mjs`: **19/19**, full acceptance. CDP reports `Chrome/157.0.8103.52 (headless)`; the 64-token run was about 33 ms, with 297 local resource entries and 1,820,173 transferred bytes. No performance/resource budget was weakened.
- Actual local environment: **Windows, Node v26.13.0, Python 3.12.3, NumPy 2.4.6**. This does not validate CI's Node 22.18.0 floor. Static bundle remains 16 files / 139,480 bytes.

### Preservation and remaining acceptance

Old E2E outputs/screenshots and verify receipt/log were backed up before any acceptance rerun in `artifacts/ci-prior-HKaQrf/`. That directory also contains the first red logs, final local test/contract logs, the current E2E console log, the pre-edit E2E source and SHA-256 values for 14 existing owner files. Those 14 light/Worker/core/UI/test files remained byte-identical. Fresh acceptance receipts are `artifacts/verify-receipt.json` and `artifacts/a2/e2e.json`.

- [ ] Execute all three GitHub-hosted matrix legs after a separately authorized publication/trigger; inspect per-OS receipts and real browser results. The local tests inject Linux/macOS discovery boundaries, not operating systems or browsers.
- [ ] Confirm installed browsers on the actual runner images. `gh` was unavailable in this session, so no public runner-image documentation or current hosted installation was verified; discovery fails closed when the runner lacks a browser.
- [ ] Observe the hosted Pages dependency gate without treating these local structural tests as a real deployment run. No remote deployment was attempted.

All changes remain uncommitted/unpushed. No subagents, dependency installation, Git-configuration changes, AGENTS changes or additional core/UI changes were made in this follow-up.
