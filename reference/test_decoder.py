"""Tests for the independent NumPy tiny-decoder-v1 reference.

These tests were written before ``decoder.py`` existed.  The first recorded run
failed at import time with ``ModuleNotFoundError: No module named 'decoder'``
(executed from the repository root as
``python -m unittest discover -s reference -p 'test_*.py' -v``).

Everything here is derived from docs/NUMERICAL_CONTRACT.md and the task brief;
no TypeScript source was read, imported or translated.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import decoder  # noqa: E402  (intentionally absent during the first TDD run)

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "reference.json"

UINT32_MODULUS = 2**32
LCG_MULTIPLIER = 1664525
LCG_INCREMENT = 1013904223
ATOL = 1e-5
RTOL = 1e-4

VOCAB = 32
MAX_CONTEXT = 64
WIDTH = 16
N_LAYERS = 2
FF_WIDTH = 32
HEAD_DIM = 8

LAYER_SHAPES = {
    "Wq": (WIDTH, WIDTH),
    "Wk": (WIDTH, WIDTH),
    "Wv": (WIDTH, WIDTH),
    "Wo": (WIDTH, WIDTH),
    "W1": (WIDTH, FF_WIDTH),
    "W2": (FF_WIDTH, WIDTH),
}


def reserved_tokens(case_index: int) -> list[int]:
    """Token stream for reserved case ``case_index`` per the brief.

    Token state starts at 7001 + case_index; for every one of the
    ``1 + case_index % 16`` tokens the shared LCG is advanced once and the
    token is ``state % 32``.
    """

    state = 7001 + case_index
    tokens = []
    for _ in range(1 + case_index % 16):
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % UINT32_MODULUS
        tokens.append(state % VOCAB)
    return tokens


def zero_weights() -> dict:
    """All-zero weights in the documented container structure."""

    def z(*shape: int) -> np.ndarray:
        return np.zeros(shape, dtype=np.float32)

    def layer() -> dict:
        return {"Wq": z(16, 16), "Wk": z(16, 16), "Wv": z(16, 16),
                "Wo": z(16, 16), "W1": z(16, 32), "W2": z(32, 16)}

    return {"E": z(32, 16), "P": z(64, 16), "layers": [layer(), layer()],
            "Wlm": z(16, 32)}


class WeightStreamTests(unittest.TestCase):
    def test_shapes_and_float32_storage(self) -> None:
        weights = decoder.make_weights(1)

        self.assertEqual(weights["E"].shape, (VOCAB, WIDTH))
        self.assertEqual(weights["P"].shape, (MAX_CONTEXT, WIDTH))
        self.assertEqual(weights["Wlm"].shape, (WIDTH, FF_WIDTH))
        self.assertEqual(len(weights["layers"]), N_LAYERS)
        for index, layer in enumerate(weights["layers"]):
            for name, shape in LAYER_SHAPES.items():
                with self.subTest(layer=index, matrix=name):
                    self.assertEqual(layer[name].shape, shape)

        arrays = [weights["E"], weights["P"], weights["Wlm"]]
        for layer in weights["layers"]:
            arrays.extend(layer.values())
        for array in arrays:
            self.assertEqual(array.dtype, np.float32)
            self.assertTrue(np.isfinite(array).all())
            self.assertLessEqual(float(np.max(np.abs(array))), 0.3)

    def test_seed_one_first_two_lcg_states(self) -> None:
        state = 1
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % UINT32_MODULUS
        self.assertEqual(state, 1015568748)
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % UINT32_MODULUS
        self.assertEqual(state, 1586005467)

        weights = decoder.make_weights(1)
        first = np.float32((1015568748 / UINT32_MODULUS - 0.5) * 0.6)
        second = np.float32((1586005467 / UINT32_MODULUS - 0.5) * 0.6)
        self.assertEqual(weights["E"][0, 0], first)
        self.assertEqual(weights["E"][0, 1], second)

    def test_deterministic_and_seed_sensitive(self) -> None:
        left = decoder.make_weights(7)
        right = decoder.make_weights(7)
        np.testing.assert_array_equal(left["E"], right["E"])
        np.testing.assert_array_equal(left["P"], right["P"])
        np.testing.assert_array_equal(left["Wlm"], right["Wlm"])
        for one, two in zip(left["layers"], right["layers"]):
            for name in LAYER_SHAPES:
                np.testing.assert_array_equal(one[name], two[name])

        digest = decoder.weights_sha256(left)
        self.assertEqual(digest, decoder.weights_sha256(right))
        self.assertEqual(len(digest), 64)
        # Regression pin: the TypeScript implementation produces the same digest for seed 7.
        self.assertEqual(
            digest,
            "75384d2cbebcc56fa5bd99495ef898bf64c2274426a9a42c7ac1a309a1ba11ce",
        )
        self.assertNotEqual(digest, decoder.weights_sha256(decoder.make_weights(42)))
        self.assertNotEqual(digest, decoder.weights_sha256(decoder.make_weights(1)))

    def test_weights_sha256_matches_independent_byte_reconstruction(self) -> None:
        seed = 7
        sizes = [VOCAB * WIDTH, MAX_CONTEXT * WIDTH]
        for _ in range(N_LAYERS):
            sizes.extend([WIDTH * WIDTH] * 4)
            sizes.extend([WIDTH * FF_WIDTH, FF_WIDTH * WIDTH])
        sizes.append(WIDTH * FF_WIDTH)

        state = seed
        scalars = []
        for _ in range(sum(sizes)):
            state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % UINT32_MODULUS
            scalars.append(np.float32((state / UINT32_MODULUS - 0.5) * 0.6))

        digest = hashlib.sha256()
        offset = 0
        for size in sizes:
            chunk = scalars[offset:offset + size]
            digest.update(struct.pack(f"<{size}f", *[float(v) for v in chunk]))
            offset += size

        self.assertEqual(decoder.weights_sha256(decoder.make_weights(seed)),
                         digest.hexdigest())

        # No header, little-endian float32: all-zero weights hash all-zero bytes.
        zero_digest = decoder.weights_sha256(zero_weights())
        self.assertEqual(zero_digest, hashlib.sha256(bytes(6144 * 4)).hexdigest())


class ScalarPrimitiveTests(unittest.TestCase):
    def test_layer_norm_matches_hand_computation(self) -> None:
        got = decoder._layer_norm(np.array([[1.0, 2.0, 3.0]], dtype=np.float32))
        self.assertEqual(got.dtype, np.float32)
        self.assertEqual(got.shape, (1, 3))

        denominator = math.sqrt(2.0 / 3.0 + 1e-5)
        expected = np.array([-1.0 / denominator, 0.0, 1.0 / denominator])
        np.testing.assert_allclose(got[0].astype(np.float64), expected,
                                   rtol=1e-6, atol=1e-7)

        flat = decoder._layer_norm(np.full(4, 5.0, dtype=np.float32))
        np.testing.assert_array_equal(flat, np.zeros(4, dtype=np.float32))

    def test_masked_softmax_matches_hand_computation(self) -> None:
        scores = np.tile(np.array([[0.0, 1.0, 2.0]]), (3, 1))
        probs = decoder._masked_softmax(scores)
        self.assertEqual(probs.dtype, np.float32)
        self.assertEqual(probs.shape, (3, 3))

        e1 = math.exp(1.0)
        row1 = np.array([1.0 / (1.0 + e1), e1 / (1.0 + e1), 0.0])
        denominator = 1.0 + e1 + e1 * e1
        row2 = np.array([1.0 / denominator, e1 / denominator,
                         e1 * e1 / denominator])

        np.testing.assert_allclose(probs[0].astype(np.float64), [1.0, 0.0, 0.0],
                                   rtol=1e-6, atol=1e-7)
        np.testing.assert_allclose(probs[1].astype(np.float64), row1,
                                   rtol=1e-6, atol=1e-7)
        np.testing.assert_allclose(probs[2].astype(np.float64), row2,
                                   rtol=1e-6, atol=1e-7)
        np.testing.assert_array_equal(probs[0, 1:], [0.0, 0.0])
        np.testing.assert_array_equal(probs[1, 2], 0.0)
        np.testing.assert_allclose(probs.sum(axis=1).astype(np.float64), 1.0,
                                   rtol=1e-6, atol=1e-7)


class ForwardTests(unittest.TestCase):
    def test_zero_weights_give_zero_logits_and_finite_outputs(self) -> None:
        weights = zero_weights()
        for tokens in ([0], [3, 5], list(range(16))):
            with self.subTest(length=len(tokens)):
                result = decoder.forward(tokens, weights)
                logits = np.asarray(result["logits"], dtype=np.float64)
                self.assertEqual(logits.shape, (len(tokens), 32))
                np.testing.assert_array_equal(logits, np.zeros_like(logits))
                for entry in result["cache"]:
                    self.assertEqual(np.asarray(entry["keys"]).shape, (len(tokens), 16))
                    self.assertEqual(np.asarray(entry["values"]).shape, (len(tokens), 16))
                    np.testing.assert_array_equal(np.asarray(entry["keys"]), 0.0)
                    np.testing.assert_array_equal(np.asarray(entry["values"]), 0.0)
                for layer_hidden in result["hidden"]:
                    self.assertEqual(np.asarray(layer_hidden).shape, (len(tokens), 16))
                    np.testing.assert_array_equal(np.asarray(layer_hidden), 0.0)
                json.dumps(result, allow_nan=False)

    def test_forward_shapes_finiteness_and_json(self) -> None:
        tokens = [5, 1, 9, 2, 17]
        weights = decoder.make_weights(1)
        result = decoder.forward(tokens, weights)

        self.assertEqual(set(result), {"logits", "cache", "hidden"})
        logits = np.asarray(result["logits"], dtype=np.float64)
        self.assertEqual(logits.shape, (len(tokens), 32))
        self.assertTrue(np.isfinite(logits).all())

        self.assertEqual(len(result["cache"]), 2)
        for index, entry in enumerate(result["cache"]):
            with self.subTest(cache_layer=index):
                self.assertEqual(set(entry), {"keys", "values"})
                keys = np.asarray(entry["keys"], dtype=np.float64)
                values = np.asarray(entry["values"], dtype=np.float64)
                self.assertEqual(keys.shape, (len(tokens), 16))
                self.assertEqual(values.shape, (len(tokens), 16))
                self.assertTrue(np.isfinite(keys).all())
                self.assertTrue(np.isfinite(values).all())

        self.assertEqual(len(result["hidden"]), 2)
        for index, layer_hidden in enumerate(result["hidden"]):
            with self.subTest(hidden_layer=index):
                hidden = np.asarray(layer_hidden, dtype=np.float64)
                self.assertEqual(hidden.shape, (len(tokens), 16))
                self.assertTrue(np.isfinite(hidden).all())

        self.assertIs(type(result["logits"][0][0]), float)
        self.assertIs(type(result["cache"][0]["keys"][0][0]), float)
        self.assertIs(type(result["hidden"][0][0][0]), float)
        json.dumps(result, allow_nan=False)

    def test_causality_of_logits(self) -> None:
        weights = decoder.make_weights(42)
        short = decoder.forward([1, 2, 3], weights)
        long = decoder.forward([1, 2, 3, 4, 5], weights)

        short_logits = np.asarray(short["logits"], dtype=np.float64)
        long_logits = np.asarray(long["logits"], dtype=np.float64)
        self.assertEqual(long_logits.shape, (5, 32))
        np.testing.assert_allclose(short_logits, long_logits[:3],
                                   atol=ATOL, rtol=RTOL)

    def test_causality_of_cache_and_hidden_prefixes(self) -> None:
        weights = decoder.make_weights(42)
        short = decoder.forward([1, 2, 3], weights)
        long = decoder.forward([1, 2, 3, 4, 5], weights)

        self.assertEqual(len(short["cache"]), 2)
        self.assertEqual(len(short["hidden"]), 2)
        for index in range(2):
            with self.subTest(layer=index):
                np.testing.assert_allclose(
                    np.asarray(short["cache"][index]["keys"], dtype=np.float64),
                    np.asarray(long["cache"][index]["keys"], dtype=np.float64)[:3],
                    atol=ATOL, rtol=RTOL)
                np.testing.assert_allclose(
                    np.asarray(short["cache"][index]["values"], dtype=np.float64),
                    np.asarray(long["cache"][index]["values"], dtype=np.float64)[:3],
                    atol=ATOL, rtol=RTOL)
                np.testing.assert_allclose(
                    np.asarray(short["hidden"][index], dtype=np.float64),
                    np.asarray(long["hidden"][index], dtype=np.float64)[:3],
                    atol=ATOL, rtol=RTOL)

        first_only = decoder.forward([1], weights)
        np.testing.assert_allclose(
            np.asarray(first_only["logits"], dtype=np.float64),
            np.asarray(long["logits"], dtype=np.float64)[:1],
            atol=ATOL, rtol=RTOL)


class InputValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.weights = decoder.make_weights(3)

    def test_invalid_tokens_rejected(self) -> None:
        invalid = [
            [],
            [-1],
            [32],
            [1, 1.5],
            [1.0],
            [True],
            [1, False],
            [0, 2**31],
            [0] * 65,
            "123",
            b"\x01\x02",
            7,
            None,
            {"tokens": [1]},
            np.array([[1, 2]], dtype=np.int64),
        ]
        for value in invalid:
            with self.subTest(tokens=repr(value)):
                with self.assertRaises(ValueError) as caught:
                    decoder.forward(value, self.weights)
                self.assertTrue(str(caught.exception).strip())

    def test_invalid_seeds_rejected(self) -> None:
        invalid = [-1, 4294967296, 1.0, 0.5, -0.5, True, False, "1", None,
                   np.float64(7.0)]
        for value in invalid:
            with self.subTest(seed=repr(value)):
                with self.assertRaises(ValueError) as caught:
                    decoder.make_weights(value)
                self.assertTrue(str(caught.exception).strip())

    def test_uint32_seed_bounds_accepted_and_numpy_integers(self) -> None:
        for seed in (0, 1, 4294967295, np.int64(7), np.uint32(7)):
            with self.subTest(seed=repr(seed)):
                weights = decoder.make_weights(seed)
                self.assertEqual(weights["E"].shape, (32, 16))

    def test_tokens_accept_tuple_and_ndarray(self) -> None:
        for tokens in ((1, 2, 3), np.array([1, 2, 3], dtype=np.int64)):
            with self.subTest(kind=type(tokens).__name__):
                result = decoder.forward(tokens, self.weights)
                self.assertEqual(np.asarray(result["logits"]).shape, (3, 32))


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = (json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
                       if FIXTURE_PATH.exists() else None)

    @unittest.skipUnless(FIXTURE_PATH.exists(), "fixture has not been generated yet")
    def test_top_level_metadata_and_provenance(self) -> None:
        fixture = self.fixture
        self.assertEqual(fixture["schemaVersion"], 1)
        self.assertEqual(fixture["modelId"], "tiny-decoder-v1")
        self.assertEqual(len(fixture["cases"]), 130)

        provenance = fixture["provenance"]
        self.assertEqual(
            provenance["decoderSha256"],
            hashlib.sha256((ROOT / "reference" / "decoder.py").read_bytes()).hexdigest())
        self.assertEqual(
            provenance["generatorSha256"],
            hashlib.sha256((ROOT / "reference" / "generate_cases.py").read_bytes()).hexdigest())
        self.assertRegex(provenance["pythonVersion"], r"^\d+\.\d+\.\d+$")
        self.assertRegex(provenance["numpyVersion"], r"^\d+\.\d+\.\d+$")

    @unittest.skipUnless(FIXTURE_PATH.exists(), "fixture has not been generated yet")
    def test_case_selection(self) -> None:
        cases = self.fixture["cases"]
        self.assertEqual(len(cases), 130)
        for index in range(128):
            with self.subTest(case=index):
                self.assertEqual(cases[index]["seed"], 1000 + index)
                self.assertEqual(cases[index]["tokens"], reserved_tokens(index))
                self.assertEqual(len(cases[index]["tokens"]), 1 + index % 16)
        self.assertEqual(cases[128]["seed"], 321)
        self.assertEqual(cases[128]["tokens"], [index % 32 for index in range(64)])
        self.assertEqual(cases[129]["seed"], 0)
        self.assertEqual(cases[129]["tokens"], [0, 1, 0])

    @unittest.skipUnless(FIXTURE_PATH.exists(), "fixture has not been generated yet")
    def test_cases_are_finite_shaped_and_weighted(self) -> None:
        for index, case in enumerate(self.fixture["cases"]):
            with self.subTest(case=index):
                length = len(case["tokens"])
                self.assertTrue(1 <= length <= 64)
                self.assertTrue(all(isinstance(t, int) and 0 <= t < 32
                                    for t in case["tokens"]))

                logits = np.asarray(case["logits"], dtype=np.float64)
                self.assertEqual(logits.shape, (length, 32))
                self.assertTrue(np.isfinite(logits).all())

                self.assertEqual(len(case["cache"]), 2)
                for entry in case["cache"]:
                    keys = np.asarray(entry["keys"], dtype=np.float64)
                    values = np.asarray(entry["values"], dtype=np.float64)
                    self.assertEqual(keys.shape, (length, 16))
                    self.assertEqual(values.shape, (length, 16))
                    self.assertTrue(np.isfinite(keys).all())
                    self.assertTrue(np.isfinite(values).all())

                self.assertEqual(len(case["hidden"]), 2)
                for layer_hidden in case["hidden"]:
                    hidden = np.asarray(layer_hidden, dtype=np.float64)
                    self.assertEqual(hidden.shape, (length, 16))
                    self.assertTrue(np.isfinite(hidden).all())

                self.assertEqual(case["weightsSha256"],
                                 decoder.weights_sha256(decoder.make_weights(case["seed"])))

    @unittest.skipUnless(FIXTURE_PATH.exists(), "fixture has not been generated yet")
    def test_seed_zero_case_matches_recomputation(self) -> None:
        case = self.fixture["cases"][129]
        recomputed = decoder.forward(case["tokens"], decoder.make_weights(case["seed"]))
        np.testing.assert_allclose(
            np.asarray(recomputed["logits"], dtype=np.float64),
            np.asarray(case["logits"], dtype=np.float64), atol=ATOL, rtol=RTOL)
        for index in range(2):
            np.testing.assert_allclose(
                np.asarray(recomputed["cache"][index]["keys"], dtype=np.float64),
                np.asarray(case["cache"][index]["keys"], dtype=np.float64),
                atol=ATOL, rtol=RTOL)
            np.testing.assert_allclose(
                np.asarray(recomputed["hidden"][index], dtype=np.float64),
                np.asarray(case["hidden"][index], dtype=np.float64),
                atol=ATOL, rtol=RTOL)


if __name__ == "__main__":
    unittest.main()
