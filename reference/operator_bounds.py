"""Independent local operator evidence; standard library only, no TS/NumPy imports.

Generate explicitly with --write NEW_PATH (exclusive creation), or --check PATH.
Ordinary Node tests only read the versioned fixture; they never regenerate it.
Run --self-test before generation. See NUMERICAL_CONTRACT.md for bound assumptions.
"""
from __future__ import annotations

import argparse
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import struct
import unittest

D = Decimal
PRECISION = 100
U64 = Fraction(1, 2**53)
U32 = Fraction(1, 2**24)
HALF_SUBNORMAL32 = Fraction(1, 2**150)
# A local regression allowance, NOT a universal bound on Math.exp/sqrt.
SCALAR_RELATIVE_ALLOWANCE = D("1e-13")


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def decimal_fraction(value):
    return D(value.numerator) / D(value.denominator)


def exact_dot(left, right):
    return sum((Fraction(a) * Fraction(b) for a, b in zip(left, right, strict=True)),
               Fraction(0))


def scalar_softmax(scores):
    # Deliberately unshifted: Decimal handles exp(1000) without binary64 overflow.
    weights = [D(score).exp() for score in scores]
    total = sum(weights)
    return [weight / total for weight in weights]


def scalar_layer_norm(values):
    numbers = [D.from_float(value) for value in values]
    count = len(numbers)
    total = sum(numbers)
    # Pairwise identity, not the production centered-squares implementation.
    variance = sum((a - b) ** 2 for i, a in enumerate(numbers)
                   for b in numbers[i + 1:]) / (count * count)
    denominator = (variance + D.from_float(1e-5)).sqrt()
    return [(count * value - total) / (count * denominator) for value in numbers]


def dot_evidence(left, right):
    exact = exact_dot(left, right)
    magnitude = sum((abs(Fraction(a) * Fraction(b))
                     for a, b in zip(left, right, strict=True)), Fraction(0))
    n = len(left)
    accumulation_bound = (n * U64 / (1 - n * U64)) * magnitude
    output_bound = accumulation_bound + U32 * (abs(exact) + accumulation_bound) + HALF_SUBNORMAL32
    return {
        "exact": str(decimal_fraction(exact)),
        "sumAbsProducts": str(decimal_fraction(magnitude)),
        "dotAbsoluteBound": str(decimal_fraction(accumulation_bound)),
        "outputAbsoluteBound": str(decimal_fraction(output_bound)),
    }


def scalar_evidence(values):
    return [{"exact": str(value),
             "absoluteBudget": str((decimal_fraction(U32) + SCALAR_RELATIVE_ALLOWANCE)
                                   * abs(value) + decimal_fraction(HALF_SUBNORMAL32))}
            for value in values]


def build_evidence(precision=PRECISION):
    with localcontext() as ctx:
        ctx.prec = precision
        dots = []
        for name, left, right in [
            ("unit-cancellation", [2**24, 1, -(2**24)], [1, 1, 1]),
            ("product-low-bits", [1 + 2**-23], [1 - 2**-23]),
            ("mixed-fractions", [0.1, -0.2, 0.3, 1 + 2**-23], [0.3, 0.2, -0.1, 0.5]),
            ("large-finite", [2**60, 2**60], [2**60, 2**60]),
            ("smallest-f32-subnormal", [2**-149], [1]),
            ("f64-is-not-exact", [2**60, 1, -(2**60)], [1, 1, 1]),
        ]:
            left, right = list(map(f32, left)), list(map(f32, right))
            dots.append({"name": name, "left": left, "right": right,
                         **dot_evidence(left, right)})

        left = list(map(f32, [2**24, 1, -(2**24), 1 + 2**-23, -1, 2**-30]))
        right = list(map(f32, [1, 1 + 2**-23, 1, 1, 1, -1]))
        matrix = {"name": "rectangular-cancellation", "rows": 2, "columns": 3,
                  "rightColumns": 2, "left": left, "right": right,
                  "expected": [dot_evidence(left[row * 3:(row + 1) * 3], right[col::2])
                               for row in range(2) for col in range(2)]}
        softmax = [{"name": name, "scores": scores,
                    "expected": scalar_evidence(scalar_softmax(scores))}
                   for name, scores in [
                       ("base", [-2, 0, 2]),
                       ("shifted", [998, 1000, 1002]),
                       ("uniform-negative", [-1000, -1000, -1000]),
                       ("extreme-gap", [1000, 0, -1000]),
                       ("subnormal-tail", [0, -100]),
                   ]]
        norms = []
        for name, values in [
            ("constant", [7, 7, 7, 7]),
            ("near-constant", [1, 1 + 2**-23, 1 - 2**-23, 1]),
            ("near-zero", [2**-30, -(2**-30), 0]),
            ("ordinary", [1, 2, 4, 8]),
        ]:
            values = list(map(f32, values))
            norms.append({"name": name, "input": values,
                          "expected": scalar_evidence(scalar_layer_norm(values))})
        return {"schemaVersion": 1, "decimalPrecision": PRECISION,
                "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "scalarRelativeAllowance": str(SCALAR_RELATIVE_ALLOWANCE),
                "dots": dots, "matrices": [matrix], "softmax": softmax, "layerNorm": norms}


def reference_values(evidence):
    yield from (entry["exact"] for entry in evidence["dots"])
    for group in ("matrices", "softmax", "layerNorm"):
        for case in evidence[group]:
            yield from (entry["exact"] for entry in case["expected"])


class OracleTests(unittest.TestCase):
    def test_integer_cancellation_is_exactly_one(self):
        self.assertEqual(exact_dot([2**24, 1, -(2**24)], [1, 1, 1]), 1)

    def test_products_retain_more_than_float32_precision(self):
        self.assertEqual(exact_dot([1 + 2**-23], [1 - 2**-23]),
                         Fraction(1) - Fraction(1, 2**46))

    def test_softmax_matches_analytic_two_to_one_ratio(self):
        with localcontext() as ctx:
            ctx.prec = PRECISION
            actual = scalar_softmax([D(0), D(2).ln()])
            self.assertLess(abs(actual[0] - D(1) / 3), D("1e-98"))
            self.assertLess(abs(actual[1] - D(2) / 3), D("1e-98"))

    def test_layer_norm_matches_analytic_symmetric_case(self):
        with localcontext() as ctx:
            ctx.prec = PRECISION
            actual = scalar_layer_norm([-1.0, 0.0, 1.0])
            expected = 1 / (D(2) / 3 + D.from_float(1e-5)).sqrt()
            for got, want in zip(actual, [-expected, D(0), expected], strict=True):
                self.assertLess(abs(got - want), D("1e-98"))
            self.assertEqual(scalar_layer_norm([7.0] * 4), [D(0)] * 4)


    def test_all_reference_values_stabilize_at_100_and_160_digits(self):
        with localcontext() as ctx:
            ctx.prec = 180
            low, high = build_evidence(100), build_evidence(160)
            for a, b in zip(reference_values(low), reference_values(high), strict=True):
                a, b = D(a), D(b)
                if b == 0:
                    self.assertEqual(a, 0)
                else:
                    self.assertLess(abs((a - b) / b), D("1e-90"))
            json.dumps(low, allow_nan=False)

    def test_softmax_translation_and_normalization(self):
        with localcontext() as ctx:
            ctx.prec = PRECISION
            base, shifted = scalar_softmax([-2, 0, 2]), scalar_softmax([998, 1000, 1002])
            for a, b in zip(base, shifted, strict=True):
                self.assertLess(abs(a - b), D("1e-98"))
            self.assertLess(abs(sum(base) - 1), D("1e-98"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--write", type=Path)
    mode.add_argument("--check", type=Path)
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner(verbosity=2).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(OracleTests))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    payload = json.dumps(build_evidence(), indent=2, allow_nan=False) + "\n"
    if args.write:
        with args.write.resolve().open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
        print(f"Wrote new evidence: {args.write.resolve()}")
    else:
        if args.check.resolve().read_text(encoding="utf-8") != payload:
            raise SystemExit("Evidence differs from independent regeneration")
        print(f"Evidence matches independent regeneration: {args.check.resolve()}")


if __name__ == "__main__":
    main()
