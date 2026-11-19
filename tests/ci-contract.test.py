"""Local workflow contracts: Python 3.12 + existing PyYAML; no runtime dependency.

Run explicitly: python tests/ci-contract.test.py -v
BaseLoader parses real YAML mappings/sequences, keeping scalars as strings (so
GitHub's `on` is not coerced to YAML 1.1's boolean True). This is not a runner
emulator: scheduler/deployment guarantees are structural assertions; only the
negative command cases execute locally, in a disposable copy of real sources.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


def load_workflow(name):
    with (ROOT / ".github" / "workflows" / name).open(encoding="utf-8") as source:
        return yaml.load(source, Loader=yaml.BaseLoader)


class CIContract(unittest.TestCase):
    def setUp(self):
        self.ci = load_workflow("ci.yml")
        self.pages = load_workflow("pages.yml")

    def matrix_job(self):
        jobs = list(self.ci["jobs"].values())
        self.assertEqual(len(jobs), 1, "one shared job must apply all gates to every OS")
        job = jobs[0]
        self.assertEqual(job["runs-on"], "${{ matrix.os }}")
        return job

    def step(self, name):
        matches = [step for step in self.matrix_job()["steps"] if step.get("name") == name]
        self.assertEqual(len(matches), 1, name)
        return matches[0]

    def test_all_three_systems_are_required_without_fail_fast(self):
        job = self.matrix_job()
        self.assertEqual(job["strategy"], {
            "fail-fast": "false",
            "matrix": {"os": ["ubuntu-latest", "windows-latest", "macos-latest"]},
        })
        self.assertNotIn("if", job)
        self.assertNotIn("continue-on-error", job)
        self.assertGreater(int(job["timeout-minutes"]), 0)
        self.assertLessEqual(int(job["timeout-minutes"]), 30)

    def test_reusable_and_manual_ci_remain_read_only(self):
        self.assertEqual(set(self.ci["on"]), {"push", "pull_request", "workflow_call", "workflow_dispatch"})
        self.assertEqual(self.ci["on"]["push"]["branches"], ["main"])
        self.assertEqual(self.ci["permissions"], {"contents": "read"})
        for job in self.ci["jobs"].values():
            self.assertNotIn("permissions", job)
        self.assertNotIn("pull_request_target", self.pages["on"])

    def test_each_system_runs_the_unconditional_full_gates_in_order(self):
        job = self.matrix_job()
        self.assertEqual(self.ci["defaults"]["run"]["shell"], "bash")
        steps = job["steps"]
        run_steps = [step for step in steps if "run" in step]
        expected_names = [
            "Normalize reference source line endings", "Install Python reference dependency", "Install Node dependencies",
            "Install workflow test dependency", "Workflow contracts",
            "Node and TypeScript tests", "Eight-stage verification gate", "Browser E2E",
        ]
        self.assertEqual([step["name"] for step in run_steps], expected_names)
        for step in run_steps:
            for bypass in ["if", "continue-on-error", "shell"]:
                self.assertNotIn(bypass, step, f"{step['name']} must inherit fail-closed bash")
            self.assertNotIn("env", step, "gates must not override budgets or select partial suites")
        self.assertNotIn("env", job)
        self.assertNotIn("env", self.ci)
        self.assertEqual(self.step("Install Python reference dependency")["run"], 'python -m pip install "numpy>=2,<3"')
        self.assertEqual(self.step("Install Node dependencies")["run"], "npm ci")
        self.assertEqual(self.step("Install workflow test dependency")["run"], 'python -m pip install "PyYAML==6.0.2"')
        self.assertEqual(self.step("Workflow contracts")["run"], "python tests/ci-contract.test.py -v")
        self.assertEqual(self.step("Node and TypeScript tests")["run"], "npm test")
        self.assertEqual(self.step("Eight-stage verification gate")["run"].strip().splitlines(), [
            "mkdir -p artifacts", "node scripts/verify.mjs 2>&1 | tee artifacts/verify.log",
        ])
        self.assertEqual(self.step("Browser E2E")["run"], "node scripts/e2e-web.mjs")
        setup = {step.get("uses"): step for step in steps if "uses" in step}
        self.assertEqual(setup["actions/setup-node@v4"]["with"]["node-version"], "22.18.0")
        self.assertEqual(setup["actions/setup-python@v5"]["with"]["python-version"], "3.12")

    def test_crlf_checkout_matches_provenance_without_concealing_source_edits(self):
        fixture = json.loads((ROOT / "tests/fixtures/reference.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="lab ci line endings ") as directory:
            sandbox = Path(directory)
            (sandbox / "reference").mkdir()
            originals = {}
            for name, key in [("decoder.py", "decoderSha256"), ("generate_cases.py", "generatorSha256")]:
                original = (ROOT / "reference" / name).read_bytes().replace(b"\r\n", b"\n")
                originals[name] = original
                crlf = original.replace(b"\n", b"\r\n")
                self.assertNotEqual(hashlib.sha256(crlf).hexdigest(), fixture["provenance"][key], "CRLF must reproduce the byte-hash mismatch")
                (sandbox / "reference" / name).write_bytes(crlf)
            step = self.step("Normalize reference source line endings")

            def normalize():
                result = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step["run"]],
                    cwd=sandbox, capture_output=True, text=True, encoding="utf-8", timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            normalize()
            for name, key in [("decoder.py", "decoderSha256"), ("generate_cases.py", "generatorSha256")]:
                actual = (sandbox / "reference" / name).read_bytes()
                self.assertEqual(actual, originals[name])
                self.assertEqual(hashlib.sha256(actual).hexdigest(), fixture["provenance"][key])
            # A source edit must still be caught by provenance; never regenerate
            # fixture hashes or restore sources from a different revision.
            changed = originals["decoder.py"] + b"\n# source changed\n"
            (sandbox / "reference/decoder.py").write_bytes(changed)
            normalize()
            self.assertEqual((sandbox / "reference/decoder.py").read_bytes(), changed)
            self.assertNotEqual(hashlib.sha256(changed).hexdigest(), fixture["provenance"]["decoderSha256"])

    def test_evidence_upload_is_always_os_unique_and_allowlisted(self):
        step = self.step("Upload evidence")
        self.assertEqual(step["if"], "always()")
        self.assertEqual(step["uses"], "actions/upload-artifact@v4")
        options = step["with"]
        self.assertEqual(options["name"], "evidence-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}")
        self.assertEqual(options.get("include-hidden-files", "false"), "false")
        self.assertEqual(set(options["path"].splitlines()), {
            "artifacts/a2/e2e.json", "artifacts/a2/*.png",
            "artifacts/verify-receipt.json", "artifacts/verify.log",
        })

    def test_pages_cannot_deploy_without_the_entire_reusable_ci(self):
        self.assertEqual(self.pages["permissions"], {"contents": "read"})
        self.assertEqual(set(self.pages["jobs"]), {"check", "deploy"})
        check = self.pages["jobs"]["check"]
        self.assertEqual(check, {"uses": "./.github/workflows/ci.yml"})
        deploy = self.pages["jobs"]["deploy"]
        needs = deploy["needs"]
        self.assertEqual(needs if isinstance(needs, list) else [needs], ["check"])
        self.assertNotIn("if", deploy, "default success() must gate deployment")
        self.assertNotIn("continue-on-error", deploy)
        self.assertEqual(deploy["permissions"], {"contents": "read", "pages": "write", "id-token": "write"})
        self.assertEqual(deploy["environment"]["name"], "github-pages")
        self.assertEqual(deploy["steps"][-1]["uses"], "actions/deploy-pages@v4")

    def run_real_gate(self, step_name, injected_env, check_receipt):
        step = self.step(step_name)
        self.assertEqual(self.ci["defaults"]["run"]["shell"], "bash")
        # Copy only build/runtime inputs, never artifacts, .git, user profiles or secrets.
        with tempfile.TemporaryDirectory(prefix="lab ci contract ") as directory:
            sandbox = Path(directory)
            for entry in ["scripts", "packages", "src", "apps/web/src", "apps/web/static", "node_modules"]:
                shutil.copytree(ROOT / entry, sandbox / entry)
            for entry in ["package.json", "tsconfig.json", "tsconfig.web.json"]:
                shutil.copy2(ROOT / entry, sandbox / entry)
            env = dict(os.environ)
            for key in ["LAB_BROWSER", "WEB_MAX_BYTES", "NODE_TEST_CONTEXT"]:
                env.pop(key, None)
            env.update(injected_env(sandbox))
            # GitHub's explicit `shell: bash` uses -e -o pipefail. No network,
            # dependency install, CI emulation or deployment is performed here.
            result = subprocess.run(
                ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step["run"]],
                cwd=sandbox, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120,
            )
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            check_receipt(sandbox, result)

    def test_real_verify_budget_failure_is_not_swallowed_by_tee(self):
        def check(sandbox, result):
            receipt = json.loads((sandbox / "artifacts/verify-receipt.json").read_text(encoding="utf-8"))
            self.assertFalse(receipt["ok"])
            self.assertEqual([(s["name"], s["ok"]) for s in receipt["stages"]], [("build", True), ("web-build", False)])
            self.assertIn("above the 1 byte budget", receipt["stages"][-1]["detail"])
            self.assertEqual(receipt["skipped"], [
                "typescript-tests", "web-tests", "python-reference-tests", "fixture-provenance", "source-mutation", "packed-artifact",
            ])
            self.assertIn("result: FAIL (1/8 stages passed)", (sandbox / "artifacts/verify.log").read_text(encoding="utf-8"))
        self.run_real_gate("Eight-stage verification gate", lambda _: {"WEB_MAX_BYTES": "1"}, check)

    def test_real_e2e_missing_override_fails_and_writes_a_failed_receipt(self):
        def check(sandbox, result):
            receipt = json.loads((sandbox / "artifacts/a2/e2e.json").read_text(encoding="utf-8"))
            self.assertFalse(receipt["ok"])
            self.assertFalse(receipt["full"])
            self.assertEqual(receipt["executed"], [])
            self.assertEqual(len(receipt["requested"]), 19)
            self.assertEqual(receipt["results"][0]["name"], "harness")
            self.assertFalse(receipt["results"][0]["ok"])
            self.assertIn("LAB_BROWSER", receipt["results"][0]["detail"])
        self.run_real_gate("Browser E2E", lambda sandbox: {"LAB_BROWSER": str(sandbox / "missing browser.exe")}, check)


if __name__ == "__main__":
    unittest.main()
