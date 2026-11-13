# Numerical contract: tiny-decoder-v1

Status: A0 frozen specification. This is an untrained, synthetic teaching model, not a language-quality benchmark. Changing a constant or rounding boundary changes the model version. This document specifies A0–A1; it does not claim the planned browser UI exists.

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
- mask-current-only: attend only to the newly appended cache entry rather than all history.

Fault runs are labelled with the mode. Their logits still come from the numerical engine, not planted results. Position 0 is identical across all modes. Tests must prove later divergence on a declared nontrivial sequence, and a normal rerun must recover.

## Python reference fixture format

A separate implementation uses NumPy full-prefix matrices and a triangular mask. It must not invoke TypeScript or import product helpers. Public functions: make_weights(seed), forward(tokens, weights), weights_sha256(weights). forward returns a JSON-convertible mapping with logits [T,32], cache [{keys:[T,16],values:[T,16]}] and hidden [layer][T][16].

Fixture file tests/fixtures/reference.json has schemaVersion=1, modelId="tiny-decoder-v1", provenance (generator SHA256, Python version, NumPy version), and cases. Each case has seed, tokens, weightsSha256, logits, cache, hidden. The generator creates 128 test seeds 1000..1127, length 1+(case_index modulo 16); token state starts at 7001+case_index and uses the same documented LCG, token=state modulo 32. Add one length-64 boundary case (seed=321, tokens cycling 0..31), plus a seed-zero case [0,1,0]. Developer examples use seeds 1,7,42, not the reserved seeds. These synthetic held-out cases are correctness tests, not a scientific generalization benchmark.

The generator writes fixture bytes only when explicitly invoked. Normal test runs read the checked-in fixture and check its generator provenance; they do not silently regenerate expected answers. Python self-tests cover zero weights, causality, shapes/finiteness, and deterministic weight bytes independently.

## Paging simulator

The simulator is independent of numerical decoding in A1. It models a finite pool of pages, each with configurable positive token capacity. A page represents KV slots across all layers and heads, not a CUDA memory pointer. A request owns an ordered sequence of physical page IDs; IDs are deterministic (lowest free first). No prefix sharing, eviction, swapping or multiple schedulers in this stage.

append(requestId, count) reserves enough pages atomically. Invalid count, request ID or insufficient capacity must leave the entire pool unchanged. release(requestId) frees pages and returns a summary; unknown release fails. snapshot exposes copies. Accounting: bytesPerToken=2*2*2*8*4=256. Logical tokens and ceil(tokens/pageSize)*pageSize are counted per request, then summed. Total capacity includes free pages; occupied allocation does not. User-selected memory display is theoretical KV payload, not JS heap, process RSS or measured VRAM.

Limits: pool 1..1024 pages; page size 1..64 tokens; request ID 1..64 ASCII characters [A-Za-z0-9_-]; positive integer append count at most pool capacity. Empty pool snapshot is valid, but no zero-token phantom request is created.

## Experiments and CLI

ExperimentInput is exactly {schemaVersion:1, seed:uint32, tokens:nonempty integer array, fault:one of the four modes}. Unknown keys, unknown versions, invalid types and contexts over 64 are rejected; parsers do not coerce strings or booleans to numbers.

ExperimentResult includes schemaVersion=1, engineVersion="0.1.0-a1", mode="numerical", model (ID, untrained=true, weightsSha256, storage and accumulation types), input, tolerances, steps, comparison and final cache. A step contains position, token, fullLogits, cachedLogits, layer-level errors and cache events from that step. firstDivergence is a zero-based token position or null. A mismatch only in the final cache is reported at the last token position, because the final cache is the state produced there; thus passes is false exactly when firstDivergence is not null. No timestamp enters the deterministic result.

CLI commands: demo; run --seed N --tokens 1,2,3 [--fault MODE]; replay FILE. run/replay emit JSON only on stdout. Exit 0 means comparison passes, 1 means numerical divergence, 2 means usage/input/runtime error. demo is an offline validation walkthrough: its exit 0 means normal passed AND every advertised faulty mode diverged. It prints human-readable observations and does not claim model quality or speed.

replay reads at most 1 MiB of JSON, requires matching report schemaVersion, engineVersion and model ID, validates its input, recomputes instead of trusting recorded results, and checks the regenerated weight fingerprint. It never executes imported content, writes files or fetches a URL. Core code does not depend on Node modules or any network transport; Node fs is restricted to the CLI.

## Scope and provenance

A1 is a command-line numerical prototype, not the complete v0.1 browser product, not production inference, and not measured GPU performance. Numerical correctness, input rejection, paging conservation and fault sensitivity are mandatory before UI expansion. Any published performance must record its actual environment and wall-clock measurements independently from simulated counters.
