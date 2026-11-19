# Numerical contract: tiny-decoder-v1

Status: A0 frozen specification, extended by A1.5 (work ledger and the
`no-cache-recompute` diagnostic mode). This is an untrained, synthetic
teaching model, not a language-quality benchmark. Changing a constant or
rounding boundary changes the model version; adding a labelled diagnostic
mode does not. This document specifies A0–A1; it does not claim the planned
browser UI exists.

## Model

Vocabulary 32 (integer token IDs 0..31), maximum context 64, 2 decoder layers, 2 attention heads, head dimension 8, model width 16, feed-forward width 32. MHA only: query and KV head counts both equal 2. No dropout, biases, trainable normalization parameters, rotary embeddings, weight tying or stochastic sampling. Position embeddings are added once at the input. Layer normalization epsilon is 1e-5. Norm variance divides by width, not width minus one.

For a token matrix X = float32(E[tokens] + P[positions]), each layer computes:

1. N = LN(X).
2. Q = N Wq, K = N Wk, V = N Wv.
3. Split the last dimension into 2 consecutive heads of width 8. Each query at position t attends only to positions 0..t. Scores are Q K-transpose / sqrt(8). Stable softmax subtracts the maximum visible score. Concatenate weighted V from each head into A.
4. Y = float32(X + A Wo).
5. X = float32(Y + ReLU(LN(Y) W1) W2).
6. After the final layer, logits = LN(X) Wlm.

Matrices are row-major and multiply on the right. LN(x) = (x - mean(x)) / sqrt(mean((x-mean(x))**2) + 1e-5). Gamma=1, beta=0. ReLU is elementwise max(0,x).

## Rounding boundaries

Weights and all materialized activations (embedding sums, LN outputs, projections, attention probabilities, attention head outputs, residual sums, ReLU outputs and logits) are stored as float32. Dot products, mean/variance, exp, softmax denominator and normalization divisions are accumulated/computed in float64, then cast once per resulting element to float32. Attention scores are transient float64. Probability-weighted value sums consume the already-rounded float32 probabilities. The attention output projection is not rounded separately: `float32(X + A Wo)` is one float64 dot-product-plus-residual accumulation followed by one float32 cast per element, exactly as written in step 4. Q, K, V, W1 and W2 results are each materialized as float32 before they are consumed. This mirrors JavaScript Number accumulation with Float32Array storage; it is not a claim of pure fp32 GPU arithmetic.

Every compared tensor must have the expected shape and finite values. A non-finite value is an error, never a successful comparison. Compare complete vectors elementwise using abs(actual-reference) <= 1e-5 + 1e-4 * abs(reference). The Python result is the reference operand for cross-language comparisons. Do not replace this with argmax equality or a single max-relative-error metric.

### Comparator boundaries

`compareVectors(actual, reference, {atol, rtol})` retains the default
`atol=1e-5`, `rtol=1e-4` and the inclusive elementwise predicate above.
Custom tolerances must be finite and non-negative (`INPUT` otherwise).
For each coordinate the reported relative error is zero when the absolute
error is zero (including +0 versus -0), otherwise
`error / max(abs(reference), atol)`. Thus exact zero with `atol=0` reports 0,
including after JSON round-trip, never NaN. A nonzero error with zero scale
reports positive Infinity; an overflowing ratio also remains Infinity, not
a finite sentinel. This diagnostic does not decide the pass/fail verdict.
Plain `JSON.stringify` serializes Infinity as null: consumers requiring a
lossless diagnostic must encode it explicitly, not interpret null as zero.
The default model reports retain their existing finite metrics.

Finite operands alone do not guarantee finite arithmetic. If subtraction,
`rtol * abs(reference)`, or addition of `atol` overflows, comparison throws
`LabError('NON_FINITE')`, including for otherwise equal operands or after an
earlier mismatch. No Infinity threshold may turn a difference into a pass.
Representable extreme and subnormal differences are compared normally;
there is no saturation and no change to the model's rounding boundaries.

### Local operator evidence (not a new model contract)

`reference/operator_bounds.py` generates the separate
`tests/fixtures/operator-bounds-v1.json`; it neither imports TypeScript nor
uses NumPy/BLAS or the existing 130-case decoder fixture. Inputs are first
rounded to binary32 with Python `struct`, matching the actual operand
values, not their ideal decimal spellings. The independent constructions are:

- Dot/matrix cells: `Fraction` products and sums are exact rational arithmetic;
  matrix reference cells are explicit row/column scalar products.
- Softmax: **unshifted** Decimal exponentials divided by their Decimal sum,
  unlike the production maximum-shifted binary64 implementation. Decimal's
  exponent range accommodates these selected scores (including 1000).
- LayerNorm: population variance is `sum(i<j, (x_i-x_j)^2) / n^2`, and the
  numerator is `n*x_i - sum(x)`, not a translation of the centered-squares
  production loop. Epsilon is the exact binary64 value of the literal `1e-5`.

The generator uses 100 significant Decimal digits. Its self-tests check
integer cancellation, product low bits, analytic scalar cases, translation
and normalization, and agreement of reference values at 100 versus 160
significant digits (relative difference below `1e-90`, exact agreement for
zero). These are independent regression checks, not interval certificates.
The JSON field named `exact` is a **serialized reference**: rational dot
results can round on Decimal serialization; transcendental/normalization
results are high-precision approximations, not exact real numbers.

#### Conditional dot and matrix bounds

Let `s = sum(a_i*b_i)`, `A = sum(abs(a_i*b_i))`, `u64 = 2^-53`,
`u32 = 2^-24`, and `gamma_n = n*u64 / (1-n*u64)`. The fixture uses:

- `E = gamma_n*A` for the binary64 dot result;
- `E + u32*(abs(s)+E) + 2^-150` for a matrix cell stored in binary32.

These follow the standard rounding-error product lemma (Higham, *Accuracy
and Stability of Numerical Algorithms*, 2nd ed., Chapter 3,
[DOI](https://doi.org/10.1137/1.9780898718027)): each term in a sequential
sum is multiplied by at most `n` factors `(1+delta)`, `abs(delta)<=u64`;
for `n*u64<1` their deviation from one is at most `gamma_n`. Summing the
absolute contributions gives `E`. A final binary32 rounding contributes
at most `u32*abs(computedSum)+2^-150`; applying
`abs(computedSum)<=abs(s)+E` gives the second expression.

Premises: valid finite binary32 operands and shapes/slices; sequential
binary64 round-to-nearest, ties-to-even arithmetic; no overflow or binary64
underflow in the accumulation; `n*u64<1`; and no binary32 overflow on final
storage. Binary32 products need at most 48 significand bits and their
nonzero magnitudes range from `2^-298` to below `2^256`, so they are exact,
normal binary64 values, even for binary32 subnormal operands. All selected
cases meet these premises. Binary32 storage must preserve gradual underflow
(no flush-to-zero); `2^-150` is half the smallest binary32 subnormal spacing.
This is an absolute error bound, not a useful relative bound near cancellation.
In particular `[2^60, 1, -2^60]` has exact sum 1 but binary64 sum 0: its
loose bound deliberately does not imply exact summation. Conversely the
`[2^24, 1, -2^24]` unit-cancellation tests require exactly 1, and are meant
to reject per-step binary32 accumulation (which gives 0).

#### Scalar budgets and measurement limits

For softmax and LayerNorm the fixture's
`(u32 + 1e-13)*abs(reference) + 2^-150` is a **local regression budget**, not
a proved forward-error bound. Its binary32 term is motivated by final
storage rounding; the additional `1e-13` has no general theorem for the
whole scalar pipeline. Passing it establishes only the selected outputs
on the tested runtime. It does not establish a pre-storage relative-error
bound or a fixed ULP guarantee for every JavaScript engine's `Math.exp`
([ECMAScript specifies implementation-approximated exp](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.exp)).
No general LayerNorm conditioning/error bound is asserted either.

Normalization is checked against the sum of these per-coordinate budgets,
plus binary64 measurement rounding. Translation equality is tested only
for the representable integer shift `[-2,0,2] + 1000`, whose centered scores
are identical; arbitrary floating-point shifts can lose information.
The extreme-gap softmax case permits tails to round/underflow to zero;
it does not certify their relative accuracy. The `[0,-100]` case separately
checks preservation of a binary32 subnormal tail. Constant and near-zero
variance LayerNorm checks use the fixed positive epsilon above.

The Node test converts Decimal strings to Number and adds a measurement
guard: `budget*(1+4*Number.EPSILON) + Number.EPSILON*abs(reference)`.
For these selected values this covers serialization/conversion and error
measurement rounding; tiny Decimal softmax tails below binary64 range are
already far below the absolute binary32 subnormal budget. This is not an
interval proof for arbitrary inputs. None of these local budgets replaces
or relaxes the model comparison's `atol=1e-5`, `rtol=1e-4`.

Sources for the oracle arithmetic are Python's
[Fraction float conversion](https://docs.python.org/3/library/fractions.html)
and [Decimal operations](https://docs.python.org/3/library/decimal.html)
(`from_float`, correctly rounded `exp` and `sqrt` at the active precision).
The generator SHA256 in the new fixture ties its provenance to source bytes;
Node tests verify that link but do not regenerate the fixture. Separately run
`python reference/operator_bounds.py --self-test`,
`python reference/operator_bounds.py --check tests/fixtures/operator-bounds-v1.json`,
and `python -m unittest discover -s reference -p 'test_*.py' -v`.
`--write NEW_PATH` is explicit exclusive creation, never an overwrite of the
original decoder fixture or of historical evidence. A generator hash proves
neither mathematical correctness nor independent authorship by itself.

## Deterministic weight stream

Seed is an integer in [0, 4294967295], including zero. State is unsigned 32-bit. For every scalar, update state = (1664525 * state + 1013904223) modulo 2**32, then emit float32((state / 4294967296 - 0.5) * 0.6).

Consume scalars in exactly this order:

- token embedding E, shape [32,16];
- position embedding P, shape [64,16];
- for layer 0 and then layer 1: Wq [16,16], Wk [16,16], Wv [16,16], Wo [16,16], W1 [16,32], W2 [32,16];
- output Wlm [16,32].

Weights SHA256 hashes the concatenation of these scalar values as IEEE754 float32 little-endian bytes in the same order, with no header. The model ID separately fixes shapes and semantics. Hashes identify content; they do not prove numerical correctness or authenticity of an arbitrary external report.

## Full and cached execution

Full execution accepts a nonempty prefix of at most 64 tokens and returns logits for every row, plus per-layer K/V matrices and layer hidden outputs. It recomputes the whole prefix and uses a triangular attention mask.

Cached execution owns a model and growing per-layer K/V, computes one new token at its absolute position, and returns that token's logits, layer hidden vectors and cache read/write events. It never recomputes old hidden vectors. Cache snapshots are copies so observers cannot mutate live state. Validate a token and context limit before changing state. Reset clears only this decoder instance. It does not mutate weights. Both paths must match the independent full Python reference.

Faults are explicit teaching features, not normal modes hidden behind heuristics:

- none: correct path;
- position-offset: after position 0, use P[(position+1) modulo 64] instead of P[position];
- cache-overwrite: after position 0, replace cache entry 0 with the new K/V before appending the new entry, at every layer;
- mask-current-only: attend only to the newly appended cache entry rather than all history;
- no-cache-recompute: a numerically exact but deliberately degraded path. Each step recomputes the whole prefix with the full-prefix engine, slices that position's logits and hidden rows, and mirrors the recomputed K/V into the internal cache so the final-cache comparison stays clean. It is the control that proves "passes the comparison" and "uses the cache" are different questions.

Fault runs are labelled with the mode. Their logits still come from the numerical engine, not planted results. Position 0 is identical across all modes. Tests must prove later divergence on a declared nontrivial sequence for the three divergent modes, and a normal rerun must recover. `no-cache-recompute` must never diverge numerically; instead it must degrade the work ledger below.

## Deterministic work ledger

Every step also reports `StepWorkStats {kvReadSlots, recomputeTokens, attentionMacs}`. The counts are integers computed from positions and layer count; no wall-clock time, random value or platform detail enters them, so two machines must produce the same ledger for the same input.

- `kvReadSlots`: attention slots read across every layer, summed over that step's cache events. A normal step at position p reads slots 0..p in both layers, so p+1 slots per layer. The no-cache path reads the whole triangular prefix once per recomputation: prefix length n = position+1 counts n(n+1)/2 slot reads per layer.
- `recomputeTokens`: hidden states recomputed at that step. The cached path recomputes only the new token (1); the no-cache path recomputes the whole prefix (n).
- `attentionMacs`: `kvReadSlots × 32`, where 32 = 2 × headDim (8) × numHeads (2) multiply-adds per slot read.

`ExperimentResult.workSummary` aggregates the steps into `totalRecomputeTokens`, `expectedCachedTokens` (= steps compared), `totalKvReadSlots`, `totalAttentionMacs` and a mode-fixed `complexityClass`:

- `O(T) step / O(T^2) total` for none, position-offset and cache-overwrite;
- `O(1) masked` for mask-current-only (attention sees a single slot);
- `O(T^2) step / O(T^3) total` for no-cache-recompute.

The class is a property of the mode, not of one sample; a short run does not relabel it. A run is degraded when `totalRecomputeTokens > expectedCachedTokens`. Degraded runs still pass the numerical comparison by construction: that is the point of the pair. Reports must present both axes, the comparison verdict and the work ledger, rather than collapsing them into one number.

## Python reference fixture format

A separate implementation uses NumPy full-prefix matrices and a triangular mask. It must not invoke TypeScript or import product helpers. Public functions: make_weights(seed), forward(tokens, weights), weights_sha256(weights). forward returns a JSON-convertible mapping with logits [T,32], cache [{keys:[T,16],values:[T,16]}] and hidden [layer][T][16].

Fixture file tests/fixtures/reference.json has schemaVersion=1, modelId="tiny-decoder-v1", provenance (generator SHA256, Python version, NumPy version), and cases. Each case has seed, tokens, weightsSha256, logits, cache, hidden. The generator creates 128 test seeds 1000..1127, length 1+(case_index modulo 16); token state starts at 7001+case_index and uses the same documented LCG, token=state modulo 32. Add one length-64 boundary case (seed=321, tokens cycling 0..31), plus a seed-zero case [0,1,0]. Developer examples use seeds 1,7,42, not the reserved seeds. These synthetic held-out cases are correctness tests, not a scientific generalization benchmark.

The generator writes fixture bytes only when explicitly invoked. Normal test runs read the checked-in fixture and check its generator provenance; they do not silently regenerate expected answers. Python self-tests cover zero weights, causality, shapes/finiteness, and deterministic weight bytes independently.

## Paging simulator

The simulator is independent of numerical decoding in A1. It models a finite pool of pages, each with configurable positive token capacity. A page represents KV slots across all layers and heads, not a CUDA memory pointer. A request owns an ordered sequence of physical page IDs; IDs are deterministic (lowest free first). No prefix sharing, eviction, swapping or multiple schedulers in this stage.

append(requestId, count) reserves enough pages atomically. Invalid count, request ID or insufficient capacity must leave the entire pool unchanged. release(requestId) frees pages and returns a summary; unknown release fails. snapshot exposes copies. Accounting: bytesPerToken=2*2*2*8*4=256. Logical tokens and ceil(tokens/pageSize)*pageSize are counted per request, then summed. Total capacity includes free pages; occupied allocation does not. User-selected memory display is theoretical KV payload, not JS heap, process RSS or measured VRAM.

Limits: pool 1..1024 pages; page size 1..64 tokens; request ID 1..64 ASCII characters [A-Za-z0-9_-]; positive integer append count at most pool capacity. Empty pool snapshot is valid, but no zero-token phantom request is created.

## Experiments and CLI

ExperimentInput is exactly {schemaVersion:1, seed:uint32, tokens:nonempty integer array, fault:one of the five modes}. Unknown keys, unknown versions, invalid types and contexts over 64 are rejected; parsers do not coerce strings or booleans to numbers.

ExperimentResult includes schemaVersion=1, engineVersion="0.1.0-a1", mode="numerical", model (ID, untrained=true, weightsSha256, storage and accumulation types), input, tolerances, steps, comparison, final cache and workSummary. A step contains position, token, fullLogits, cachedLogits, layer-level errors, cache events and the step's work ledger. firstDivergence is a zero-based token position or null. A mismatch only in the final cache is reported at the last token position, because the final cache is the state produced there; thus passes is false exactly when firstDivergence is not null. No timestamp enters the deterministic result.

CLI commands: demo; run --seed N --tokens 1,2,3 [--fault MODE]; replay FILE. run/replay emit JSON only on stdout. Exit 0 means comparison passes, 1 means numerical divergence, 2 means usage/input/runtime error. demo is an offline validation walkthrough: its exit 0 means normal passed, every divergent fault was caught after the first position, and the no-cache control stayed numerically exact while its work ledger degraded. It prints human-readable observations and does not claim model quality or speed.

replay reads at most 1 MiB of JSON, requires matching report schemaVersion, engineVersion and model ID, validates its input, recomputes instead of trusting recorded results, and checks the regenerated weight fingerprint. It never executes imported content, writes files or fetches a URL. Core code does not depend on Node modules or any network transport; Node fs is restricted to the CLI.

## Scope and provenance

A1 is a command-line numerical prototype, not the complete v0.1 browser product, not production inference, and not measured GPU performance. Numerical correctness, input rejection, paging conservation and fault sensitivity are mandatory before UI expansion. Any published performance must record its actual environment and wall-clock measurements independently from simulated counters.
