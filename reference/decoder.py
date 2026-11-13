"""Independent NumPy full-matrix reference for the tiny-decoder-v1 model (A0).

Derived only from ``docs/NUMERICAL_CONTRACT.md`` and the task brief; it does
not import, execute or translate the TypeScript engine.

Numerical rules implemented here:

* weights and every materialized activation are ``numpy.float32``;
* dot products, means/variances, exponentials and the softmax denominator are
  computed in ``float64`` and cast once per resulting element to float32;
* attention scores are transient float64, softmax probabilities are rounded to
  float32 before the probability-weighted value sum (accumulated in float64);
* position embeddings are added once at the input;
* layer normalization uses epsilon 1e-5 with the variance divided by the
  feature count of the normalized axis.

Public API: ``make_weights(seed)``, ``forward(tokens, weights)`` and
``weights_sha256(weights)``.
"""

from __future__ import annotations

import hashlib
import math
import numbers
import struct

import numpy as np

VOCAB_SIZE = 32
MAX_CONTEXT = 64
N_LAYERS = 2
N_HEADS = 2
HEAD_DIM = 8
WIDTH = 16
FF_WIDTH = 32
LN_EPSILON = 1e-5

UINT32_MODULUS = 2**32
LCG_MULTIPLIER = 1664525
LCG_INCREMENT = 1013904223
WEIGHT_SCALE = 0.6

F32 = np.float32

LAYER_WEIGHT_ORDER = ("Wq", "Wk", "Wv", "Wo", "W1", "W2")

TOTAL_WEIGHT_SCALARS = (
    VOCAB_SIZE * WIDTH + MAX_CONTEXT * WIDTH
    + N_LAYERS * (4 * WIDTH * WIDTH + WIDTH * FF_WIDTH + FF_WIDTH * WIDTH)
    + WIDTH * FF_WIDTH
)


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def _validate_seed(seed) -> int:
    """Return the seed as a plain int, rejecting bools, floats and non-uint32."""

    if isinstance(seed, bool) or not isinstance(seed, numbers.Integral):
        raise ValueError(
            "seed must be an integer in [0, 4294967295]; got "
            f"{type(seed).__name__} {seed!r}")
    value = int(seed)
    if value < 0 or value >= UINT32_MODULUS:
        raise ValueError(
            f"seed must be an integer in [0, 4294967295]; got {value}")
    return value


def _validate_tokens(tokens) -> list[int]:
    """Return the token list as plain ints, rejecting anything but integers."""

    if isinstance(tokens, np.ndarray):
        if tokens.ndim != 1:
            raise ValueError(
                f"tokens must be a one-dimensional sequence; got shape {tokens.shape}")
        raw = tokens.tolist()
    elif isinstance(tokens, (list, tuple)):
        raw = list(tokens)
    else:
        raise ValueError(
            "tokens must be a nonempty sequence of integers in [0, 32); got "
            f"{type(tokens).__name__}")

    if not raw:
        raise ValueError("tokens must be nonempty")
    if len(raw) > MAX_CONTEXT:
        raise ValueError(
            f"tokens length {len(raw)} exceeds maximum context {MAX_CONTEXT}")

    validated: list[int] = []
    for position, token in enumerate(raw):
        if isinstance(token, bool) or not isinstance(token, numbers.Integral):
            raise ValueError(
                f"token at index {position} must be an integer in [0, 32); got "
                f"{type(token).__name__} {token!r}")
        value = int(token)
        if value < 0 or value >= VOCAB_SIZE:
            raise ValueError(
                f"token at index {position} must be in [0, 32); got {value}")
        validated.append(value)
    return validated


# --------------------------------------------------------------------------
# Deterministic weight stream
# --------------------------------------------------------------------------


def _lcg_scalars(seed: int, count: int) -> np.ndarray:
    """Generate ``count`` float32 scalars from the contract LCG."""

    state = seed
    values = np.empty(count, dtype=F32)
    for index in range(count):
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % UINT32_MODULUS
        values[index] = F32((state / UINT32_MODULUS - 0.5) * WEIGHT_SCALE)
    return values


def make_weights(seed) -> dict:
    """Build the deterministic weights for ``seed`` as float32 arrays.

    Layout and consumption order follow the contract: E, P, then for each of
    the two layers Wq, Wk, Wv, Wo, W1, W2, then Wlm.
    """

    checked = _validate_seed(seed)
    stream = _lcg_scalars(checked, TOTAL_WEIGHT_SCALARS)
    offset = 0

    def take(shape: tuple[int, int]) -> np.ndarray:
        nonlocal offset
        count = shape[0] * shape[1]
        matrix = stream[offset:offset + count].reshape(shape).copy()
        offset += count
        return matrix

    embedding = take((VOCAB_SIZE, WIDTH))
    position = take((MAX_CONTEXT, WIDTH))

    layers = []
    for _ in range(N_LAYERS):
        layers.append({
            "Wq": take((WIDTH, WIDTH)),
            "Wk": take((WIDTH, WIDTH)),
            "Wv": take((WIDTH, WIDTH)),
            "Wo": take((WIDTH, WIDTH)),
            "W1": take((WIDTH, FF_WIDTH)),
            "W2": take((FF_WIDTH, WIDTH)),
        })

    output = take((WIDTH, FF_WIDTH))
    assert offset == TOTAL_WEIGHT_SCALARS
    return {"E": embedding, "P": position, "layers": layers, "Wlm": output}


def _iter_weight_arrays(weights: dict):
    """Yield weight matrices in the hashed/multiplied order."""

    yield weights["E"]
    yield weights["P"]
    for layer in weights["layers"]:
        for name in LAYER_WEIGHT_ORDER:
            yield layer[name]
    yield weights["Wlm"]


def weights_sha256(weights: dict) -> str:
    """SHA-256 of the weight scalars as IEEE754 float32 little-endian bytes.

    This is independent byte-level code (``struct``), not derived from the
    forward pass.  The stream has no header.
    """

    digest = hashlib.sha256()
    for array in _iter_weight_arrays(weights):
        flat = np.ascontiguousarray(np.asarray(array, dtype=F32)).ravel()
        count = int(flat.size)
        digest.update(struct.pack(f"<{count}f", *[float(v) for v in flat]))
    return digest.hexdigest()


# --------------------------------------------------------------------------
# Numerical primitives (float64 accumulation, float32 materialization)
# --------------------------------------------------------------------------


def _layer_norm(x) -> np.ndarray:
    """LN over the last axis: epsilon 1e-5, variance divided by width."""

    values = np.asarray(x, dtype=np.float64)
    mean = np.mean(values, axis=-1, keepdims=True)
    centered = values - mean
    variance = np.mean(centered * centered, axis=-1, keepdims=True)
    normalized = centered / np.sqrt(variance + LN_EPSILON)
    return normalized.astype(F32)


def _project(activations, matrix) -> np.ndarray:
    """float32 = float64 dot product, cast once per element."""

    return (np.asarray(activations, dtype=np.float64)
            @ np.asarray(matrix, dtype=np.float64)).astype(F32)


def _masked_softmax(scores) -> np.ndarray:
    """Causal softmax over a square float64 score matrix; float32 result.

    Position j is visible to query i only when j <= i.  The maximum is
    subtracted before exponentiation and the denominator is float64.
    """

    values = np.asarray(scores, dtype=np.float64)
    if values.ndim != 2 or values.shape[0] != values.shape[1]:
        raise ValueError(
            f"attention scores must be a square matrix; got shape {values.shape}")

    length = values.shape[0]
    visible = np.tril(np.ones((length, length), dtype=bool))
    masked = np.where(visible, values, -np.inf)

    row_max = np.max(masked, axis=1, keepdims=True)
    exponentials = np.exp(masked - row_max)
    probabilities = exponentials / np.sum(exponentials, axis=1, keepdims=True)
    return probabilities.astype(F32)


def _attention(normalized, layer: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Multi-head causal attention; returns (A, K, V) all float32."""

    q = _project(normalized, layer["Wq"])
    k = _project(normalized, layer["Wk"])
    v = _project(normalized, layer["Wv"])

    length = q.shape[0]
    heads_q = q.reshape(length, N_HEADS, HEAD_DIM).transpose(1, 0, 2)
    heads_k = k.reshape(length, N_HEADS, HEAD_DIM).transpose(1, 0, 2)
    heads_v = v.reshape(length, N_HEADS, HEAD_DIM).transpose(1, 0, 2)

    attended = np.empty((length, WIDTH), dtype=F32)
    scale = math.sqrt(HEAD_DIM)
    for head in range(N_HEADS):
        scores = ((np.asarray(heads_q[head], dtype=np.float64)
                   @ np.asarray(heads_k[head], dtype=np.float64).T) / scale)
        probabilities = _masked_softmax(scores)
        weighted = (np.asarray(probabilities, dtype=np.float64)
                    @ np.asarray(heads_v[head], dtype=np.float64))
        attended[:, head * HEAD_DIM:(head + 1) * HEAD_DIM] = weighted.astype(F32)

    return attended, k, v


def _nested(array) -> list:
    """Convert to ordinary nested Python lists of Python floats."""

    return np.asarray(array, dtype=F32).tolist()


# --------------------------------------------------------------------------
# Full-prefix forward pass
# --------------------------------------------------------------------------


def forward(tokens, weights: dict) -> dict:
    """Run the full prefix through the decoder; returns JSON-convertible data.

    Result: ``{"logits": [T][32], "cache": [{"keys": [T][16],
    "values": [T][16]} for each layer], "hidden": [layer][T][16]}``.
    """

    token_ids = _validate_tokens(tokens)
    length = len(token_ids)

    embedding = np.asarray(weights["E"], dtype=F32)
    position = np.asarray(weights["P"], dtype=F32)

    hidden_state = (np.asarray(embedding[token_ids], dtype=np.float64)
                    + np.asarray(position[:length], dtype=np.float64)).astype(F32)

    keys: list[np.ndarray] = []
    values: list[np.ndarray] = []
    hidden: list[np.ndarray] = []

    for layer in weights["layers"]:
        normalized = _layer_norm(hidden_state)
        attended, layer_keys, layer_values = _attention(normalized, layer)

        residual = (np.asarray(hidden_state, dtype=np.float64)
                    + np.asarray(attended, dtype=np.float64)
                    @ np.asarray(layer["Wo"], dtype=np.float64)).astype(F32)

        feed_forward = _project(
            np.maximum(_project(_layer_norm(residual), layer["W1"]), 0.0).astype(F32),
            layer["W2"])

        hidden_state = (np.asarray(residual, dtype=np.float64)
                        + np.asarray(feed_forward, dtype=np.float64)).astype(F32)

        keys.append(np.asarray(layer_keys, dtype=F32))
        values.append(np.asarray(layer_values, dtype=F32))
        hidden.append(hidden_state)

    logits = _project(_layer_norm(hidden_state), weights["Wlm"])

    return {
        "logits": _nested(logits),
        "cache": [{"keys": _nested(one), "values": _nested(two)}
                  for one, two in zip(keys, values)],
        "hidden": [_nested(layer_output) for layer_output in hidden],
    }
