#!/usr/bin/env python3
"""Generate the checked-in reference fixture for tiny-decoder-v1.

Explicit invocation only; normal test runs never regenerate expected answers::

    python reference/generate_cases.py --output tests/fixtures/reference.json

Case selection (fixed by the numerical contract and the task brief):

* 128 reserved cases, case index ``i`` in 0..127, in order:
  seed ``1000 + i``, length ``1 + (i % 16)``.  The token stream starts with
  state ``7001 + i``; for each token the shared LCG is advanced exactly once,
  ``state = (1664525 * state + 1013904223) % 2**32``, and the token is
  ``state % 32``.  The advanced state carries into the next token.
* one length-64 boundary case: seed ``321``, tokens cycling ``0..31``
  (``tokens[j] = j % 32``).
* one seed-zero case: seed ``0``, tokens ``[0, 1, 0]``.

Every case runs the same public functions as the reference engine
(``make_weights``, ``forward``, ``weights_sha256``).  The fixture records
schema version 1, the model ID and provenance: SHA-256 of this generator's
source bytes, SHA-256 of ``decoder.py`` source bytes, the Python version and
the NumPy version.  Output bytes are written only to ``--output`` and never
overwritten without ``--force``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import decoder  # noqa: E402  (same directory as this script)

SCHEMA_VERSION = 1
MODEL_ID = "tiny-decoder-v1"
RESERVED_CASE_COUNT = 128
BOUNDARY_SEED = 321
BOUNDARY_LENGTH = 64
SEED_ZERO_CASE = (0, [0, 1, 0])


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reserved_tokens(case_index: int) -> list[int]:
    """Token stream for reserved case ``case_index`` (see module docstring)."""

    state = 7001 + case_index
    tokens = []
    for _ in range(1 + case_index % 16):
        state = (decoder.LCG_MULTIPLIER * state + decoder.LCG_INCREMENT) % decoder.UINT32_MODULUS
        tokens.append(state % decoder.VOCAB_SIZE)
    return tokens


def build_case(seed: int, tokens: list[int]) -> dict:
    weights = decoder.make_weights(seed)
    result = decoder.forward(tokens, weights)
    return {
        "seed": seed,
        "tokens": tokens,
        "weightsSha256": decoder.weights_sha256(weights),
        "logits": result["logits"],
        "cache": result["cache"],
        "hidden": result["hidden"],
    }


def build_fixture() -> dict:
    cases = [build_case(1000 + index, reserved_tokens(index))
             for index in range(RESERVED_CASE_COUNT)]
    cases.append(build_case(BOUNDARY_SEED, [index % 32 for index in range(BOUNDARY_LENGTH)]))
    cases.append(build_case(SEED_ZERO_CASE[0], list(SEED_ZERO_CASE[1])))

    provenance = {
        "generatorSha256": sha256_file(Path(__file__).resolve()),
        "decoderSha256": sha256_file(HERE / "decoder.py"),
        "pythonVersion": platform.python_version(),
        "numpyVersion": np.__version__,
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "modelId": MODEL_ID,
        "provenance": provenance,
        "cases": cases,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the tiny-decoder-v1 reference fixture.")
    parser.add_argument("--output", required=True, type=Path,
                        help="destination path for the fixture JSON")
    parser.add_argument("--force", action="store_true",
                        help="overwrite an existing fixture file")
    args = parser.parse_args(argv)

    output: Path = args.output
    if output.exists() and not args.force:
        print(f"refusing to overwrite {output} without --force", file=sys.stderr)
        return 2
    if output.is_dir():
        print(f"output path {output} is a directory", file=sys.stderr)
        return 2
    if not output.parent.is_dir():
        print(f"output directory {output.parent} does not exist", file=sys.stderr)
        return 2

    payload = build_fixture()
    try:
        text = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    except ValueError as error:
        print(f"non-finite number produced; refusing to write: {error}",
              file=sys.stderr)
        return 1
    data = (text + "\n").encode("utf-8")

    output.write_bytes(data)
    print(f"wrote {output}")
    print(f"cases: {len(payload['cases'])} "
          f"({RESERVED_CASE_COUNT} reserved + 1 boundary + 1 seed-zero)")
    print(f"fixtureSha256: {hashlib.sha256(data).hexdigest()}")
    print(f"generatorSha256: {payload['provenance']['generatorSha256']}")
    print(f"decoderSha256: {payload['provenance']['decoderSha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
